// deno run --allow-net --allow-env --allow-read main.ts --serve --client-id=xxx
// deno test --allow-net --allow-env --allow-read main.ts
//
// GitHub Deploy Key Dashboard — Deno app (local + Deno Deploy)
//
// ─── Environment Variables ───────────────────────────────────────────────────
//   GITHUB_CLIENT_ID       GitHub OAuth App client ID (required)
//   GITHUB_CLIENT_SECRET   GitHub OAuth App client secret (required)
//   SECRET                 Encryption key for cookie persistence (optional)
//   GITHUB_TOKEN           Direct GitHub token — skips OAuth (optional, dev/testing)
//   CALLBACK_URL           Full callback URL (optional, auto-derived from Host header)
//
// ─── OAuth Setup ─────────────────────────────────────────────────────────────
//   1. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App
//   2. Authorization callback URL → your app's /callback
//      e.g. http://localhost:8787/callback  or  https://my-app.deno.dev/callback
//   3. Copy Client ID → set GITHUB_CLIENT_ID
//   4. Copy Client Secret → set GITHUB_CLIENT_SECRET
//
// ─── Local Usage ─────────────────────────────────────────────────────────────
//   export GITHUB_CLIENT_ID=xxx
//   export GITHUB_CLIENT_SECRET=xxx
//   deno run --allow-net --allow-env --allow-read main.ts --serve
//
// ─── Deno Deploy ─────────────────────────────────────────────────────────────
//   Set env vars in the Deno Deploy dashboard, deploy main.ts.
//   SSH public key is entered via the web UI (no PUB_KEY env var needed).

export * from "./src/types.ts";
export * from "./src/errors.ts";
export * from "./src/helpers.ts";
export * from "./src/crypto.ts";
export * from "./src/github.ts";
export * from "./src/html.ts";

import { Hono, type Context } from "npm:hono";
import { logger } from "npm:hono/logger";
import { parseArgs } from "jsr:@std/cli";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

import type { CryptoKeyRef } from "./src/crypto.ts";
import type { RepoStatus, AppState } from "./src/types.ts";
import { TokenExpiredError } from "./src/errors.ts";
import { normalizeKey, escapeHtml, parseCookies, cookieSet, parseRepo } from "./src/helpers.ts";
import { initKey, encryptWith, decryptWith, pkceChallenge, randomBytes, base64UrlEncode } from "./src/crypto.ts";
import { GitHubClient } from "./src/github.ts";
import {
  renderLoginPage,
  renderSetupPage,
  renderRegisterPage,
  renderDashboard,
} from "./src/html.ts";

// ─── App Logic ───────────────────────────────────────────────────────────────

async function loadRepoStatuses(client: GitHubClient, normalizedKey: string): Promise<RepoStatus[]> {
  console.log("  Fetching repo list…");
  const repos = await client.listAllRepos();
  console.log(`  Found ${repos.length} repos. Checking deploy keys (batch of 10)…`);

  const statuses: RepoStatus[] = [];
  const adminRepos = repos.filter((r) => r.permissions?.admin);
  const noAdminRepos = repos.filter((r) => !r.permissions?.admin);

  for (let i = 0; i < adminRepos.length; i += 10) {
    const chunk = adminRepos.slice(i, i + 10);
    const results = await Promise.all(
      chunk.map(async (repo): Promise<RepoStatus> => {
        try {
          const keys = await client.listDeployKeys(repo.owner.login, repo.name);
          const match = keys.find((k) => normalizeKey(k.key) === normalizedKey);
          return { repo, keyId: match?.id ?? null, hasAdmin: true };
        } catch {
          return { repo, keyId: null, hasAdmin: false };
        }
      }),
    );
    statuses.push(...results);
    if (i + 10 < adminRepos.length) console.log(`  ...${Math.min(i + 10, adminRepos.length)}/${adminRepos.length} checked`);
  }
  statuses.push(...noAdminRepos.map((repo): RepoStatus => ({ repo, keyId: null, hasAdmin: false })));

  return statuses.sort((a, b) => {
    const rank = (s: RepoStatus) => !s.hasAdmin ? 2 : s.keyId !== null ? 0 : 1;
    return rank(a) - rank(b) || a.repo.full_name.localeCompare(b.repo.full_name);
  });
}

// ─── App Factory ─────────────────────────────────────────────────────────────

async function createApp(config: {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  key: CryptoKeyRef;
  ghToken?: string;
}) {
  const { clientId, clientSecret, callbackUrl, key: encryptionKey, ghToken } = config;

  const COOKIE_NAME = "session";
  const SSH_COOKIE = "ssh_key";
  const MAX_AGE_SECS = 30 * 24 * 3600;

  function getSshKey(c: { get: (k: string) => string | undefined }): string {
    return c.get(SSH_COOKIE) ?? "";
  }

  function parsePerm(s: string): boolean {
    return s !== "RO";
  }

  type Variables = {
    secure: boolean;
    gh_token: string;
    ssh_key: string;
    client: GitHubClient;
  };
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", logger());

  // ── Auth middleware ──────────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    c.set("secure", c.req.header("X-Forwarded-Proto") === "https" || c.req.url.startsWith("https"));
    // Parse & decrypt session cookie
    const raw = parseCookies(c.req.header("Cookie") ?? null);
    const packet = raw[COOKIE_NAME];
    if (packet) {
      const plain = await decryptWith(encryptionKey, packet);
      if (plain) c.set("gh_token", plain);
    }
    // Parse & decrypt SSH key cookie — fail on corrupted cookies
    const sshPacket = raw[SSH_COOKIE];
    if (sshPacket) {
      const plain = await decryptWith(encryptionKey, sshPacket);
      if (!plain) {
        return c.text(
          "저장된 SSH 키 쿠키를 복호화할 수 없습니다. /setup에서 키를 다시 등록하거나 쿠키를 삭제해주세요.",
          400,
        );
      }
      c.set(SSH_COOKIE, plain);
    }
    await next();
  });

  // ── Unauthenticated routes ───────────────────────────────────────────────

  app.get("/auth/github", async (c) => {
    const verifier = randomBytes(32);
    const challenge = await pkceChallenge(verifier);
    const next = c.req.query("next") || "/";
    const statePayload = JSON.stringify({ v: verifier, n: next });
    const encryptedState = await encryptWith(encryptionKey, statePayload);

    const redirectUri = c.req.query("redirect_uri") || callbackUrl;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: encryptedState,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "repo",
    });
    return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("Missing code or state", 400);

    const plain = await decryptWith(encryptionKey, state);
    if (!plain) return c.text("Invalid state", 400);
    const payload = JSON.parse(plain) as { v?: string; n?: string; r?: string };
    if (!payload.v) return c.text("Invalid state payload", 400);

    const redirectUri = payload.r || callbackUrl;

    const tempClient = new GitHubClient("");
    try {
      const accessToken = await tempClient.exchangeCode(code, payload.v, clientId, clientSecret, redirectUri);
      const encryptedToken = await encryptWith(encryptionKey, accessToken);
      const next = payload.n || "/";
      c.header("Set-Cookie", cookieSet(COOKIE_NAME, encryptedToken, { maxAge: MAX_AGE_SECS, sameSite: "Lax" }));
      return c.redirect(next);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.text(`OAuth failed: ${msg}`, 400);
    }
  });

  app.get("/logout", (c) => {
    c.header("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
    return c.redirect("/");
  });

  // ── Auth guard & shared state ────────────────────────────────────────────

  async function authGuard(c: any, next: () => Promise<void>) {
    const token = c.get("gh_token") || ghToken;
    if (!token) {
      const redirectUrl = `/auth/github?next=${encodeURIComponent(c.req.url)}`;
      return c.html(renderLoginPage(redirectUrl));
    }
    c.set("client", new GitHubClient(token));
    await next();
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  app.get("/setup", authGuard, (c) => c.html(renderSetupPage()));

  app.post("/setup", authGuard, async (c) => {
    const { pubkey } = await c.req.json();
    if (typeof pubkey !== "string" || !pubkey.startsWith("ssh-")) {
      return c.json({ error: "Invalid SSH public key" }, 400);
    }
    const encrypted = await encryptWith(encryptionKey, pubkey);
    c.header("Set-Cookie", cookieSet(SSH_COOKIE, encrypted, { maxAge: MAX_AGE_SECS, sameSite: "Lax" }));
    return c.json({ ok: true });
  });

  app.get("/", authGuard, async (c) => {
    const client: GitHubClient = c.get("client");
    const sshKey = getSshKey(c);

    if (!sshKey) return c.redirect("/setup");

    // If ghToken is set, we're in read-only mode
    const readOnly = !!ghToken;
    const normalizedKey = normalizeKey(sshKey);

    try {
      const statuses = await loadRepoStatuses(client, normalizedKey);
      const state: AppState = {
        sshKey,
        sshKeyTitle: sshKey.split(/\s+/).slice(-1)[0] || "ssh key",
        normalizedKey,
        repos: statuses,
        loadedAt: new Date(),
        readOnly,
      };
      return c.html(renderDashboard(state));
    } catch (err: unknown) {
      if (err instanceof TokenExpiredError) {
        return c.redirect("/logout");
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(`<div class="p-8 text-error">Error: ${escapeHtml(msg)}</div>`);
    }
  });

  app.get("/register", (c) => {
    const repo = c.req.query("repo") || "";
    const pubkey = c.req.query("pubkey") || getSshKey(c) || "";
    const perm = c.req.query("perm") || "RW";
    const keyName = c.req.query("key_name") || "nanobot";
    const result = c.req.query("_result");
    let success: string | undefined;
    let error: string | undefined;
    if (result) {
      try {
        const parsed = JSON.parse(result);
        if (parsed.ok) success = parsed.ok;
        else error = parsed.error || "Unknown error";
      } catch { /* ignore */ }
    }
    return c.html(renderRegisterPage({ repo, pubkey, perm, keyName, success, error }));
  });

  app.post("/api/register", authGuard, async (c) => {
    const client: GitHubClient = c.get("client");
    const body = await c.req.parseBody<{ repo: string; pubkey: string; perm: string; key_name: string }>();
    const { repo, pubkey, perm, key_name } = body;

    if (!repo || !pubkey) return c.json({ error: "Missing repo or pubkey" }, 400);
    const parsed = parseRepo(repo);
    if (!parsed) return c.json({ error: "Invalid repo format (use owner/repo)" }, 400);
    if (!pubkey.startsWith("ssh-")) return c.json({ error: "Invalid SSH public key" }, 400);

    const fullName = `${parsed.owner}/${parsed.repo}`;
    try {
      await client.addDeployKey(parsed.owner, parsed.repo, key_name || "nanobot", pubkey, parsePerm(perm));
      const qs = new URL(c.req.url).search;
      const result = JSON.stringify({ ok: `Key registered on ${fullName}` });
      return c.redirect(`/register?${qs ? qs.slice(1) : ""}&_result=${encodeURIComponent(result)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const qs = new URL(c.req.url).search;
      const result = JSON.stringify({ error: msg });
      return c.redirect(`/register?${qs ? qs.slice(1) : ""}&_result=${encodeURIComponent(result)}`);
    }
  });

  app.post("/api/delete", authGuard, async (c) => {
    const client: GitHubClient = c.get("client");
    const body = await c.req.json<{ owner: string; repo: string; keyId: number }>();
    const { owner, repo, keyId } = body;
    if (!owner || !repo || !keyId) return c.json({ error: "Missing fields" }, 400);
    try {
      await client.removeDeployKey(owner, repo, keyId);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.post("/api/create-repo", authGuard, async (c) => {
    const client: GitHubClient = c.get("client");
    const body = await c.req.json<{ name: string; private: boolean }>();
    const { name, private: isPrivate } = body;
    if (!name) return c.json({ error: "Missing repo name" }, 400);
    try {
      const repo = await client.createRepo(name, isPrivate);
      return c.json({ full_name: repo.full_name });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const TEST_RUNNERS = [
  () => Deno.test("normalizeKey strips extra fields", () => {
    assertEquals(normalizeKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr nanobot-risuai"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr");
  }),
  () => Deno.test("normalizeKey handles multiple spaces", () => {
    assertEquals(normalizeKey("  ssh-rsa   AAAAB3NzaC1yc2EAAAADAQABAAABAQDC  comment  "), "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDC");
  }),
  () => Deno.test("normalizeKey handles minimal key", () => {
    assertEquals(normalizeKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5");
  }),
  () => Deno.test("normalizeKey is idempotent", () => {
    const k = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr";
    assertEquals(normalizeKey(k), k);
    assertEquals(normalizeKey(normalizeKey(k + "   extra")), k);
  }),
  () => Deno.test("escapeHtml escapes special chars", () => {
    assertEquals(escapeHtml("<script>alert(\"xss\")</script>"), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  }),
  () => Deno.test("escapeHtml escapes & first", () => {
    assertEquals(escapeHtml("a&b"), "a&amp;b");
    assertEquals(escapeHtml("&amp;"), "&amp;amp;");
  }),
  () => Deno.test("escapeHtml passes safe strings", () => {
    assertEquals(escapeHtml("hello"), "hello");
    assertEquals(escapeHtml(""), "");
  }),
  () => Deno.test("parseCookies parses header", () => {
    const c = parseCookies("a=1; b=hello; gh_token=xyz");
    assertEquals(c.a, "1");
    assertEquals(c.gh_token, "xyz");
  }),
  () => Deno.test("parseCookies handles empty", () => {
    assertEquals(parseCookies(null), {});
    assertEquals(parseCookies(""), {});
  }),
  () => Deno.test("cookieSet produces valid cookie", () => {
    const c = cookieSet("x", "y");
    assertStringIncludes(c, "x=y");
    assertStringIncludes(c, "HttpOnly");
    assertStringIncludes(c, "Path=/");
  }),
  () => Deno.test("cookieSet supports SameSite", () => {
    assertStringIncludes(cookieSet("x", "y", { sameSite: "Lax" }), "SameSite=Lax");
  }),
  () => Deno.test("base64UrlEncode produces URL-safe output", () => {
    const r = base64UrlEncode(new TextEncoder().encode("hello"));
    assertEquals(r.includes("+"), false);
    assertEquals(r.includes("/"), false);
    assertEquals(r.includes("="), false);
  }),
  () => Deno.test("encrypt/decrypt roundtrip", async () => {
    const key = await initKey("test-secret");
    const p = await encryptWith(key, "gho_sampletoken123");
    assertEquals(typeof p, "string");
    assertStringIncludes(p, ".");
    assertEquals(await decryptWith(key, p), "gho_sampletoken123");
  }),
  () => Deno.test("decrypt garbage returns null", async () => {
    const key = await initKey("test-secret");
    assertEquals(await decryptWith(key, "invalid.format"), null);
  }),
  () => Deno.test("decrypt tampered returns null", async () => {
    const key = await initKey("test-secret");
    const p = await encryptWith(key, "token123");
    const dot = p.indexOf(".");
    const prefix = p.slice(0, dot + 1);
    const b64 = [...p.slice(dot + 1)];
    b64[0] = b64[0] === "A" ? "B" : "A";
    const t = prefix + b64.join("");
    assertEquals(await decryptWith(key, t), null);
  }),
  () => Deno.test("randomBytes URL-safe", () => {
    const r = randomBytes(32);
    assertEquals(r.includes("+"), false);
    assertEquals(r.includes("/"), false);
    assertEquals(r.length > 0, true);
  }),
  () => Deno.test("pkceChallenge works", async () => {
    const c = await pkceChallenge(randomBytes(32));
    assertEquals(c.includes("="), false);
    assertEquals(c.length > 0, true);
  }),
  () => Deno.test("parseRepo extracts owner/repo", () => {
    const r = parseRepo("concertypin/my-repo");
    assertEquals(r?.owner, "concertypin");
    assertEquals(r?.repo, "my-repo");
  }),
  () => Deno.test("parseRepo rejects invalid", () => {
    assertEquals(parseRepo(""), null);
    assertEquals(parseRepo("no-slash"), null);
    assertEquals(parseRepo("/leading-slash"), null);
  }),
  () => Deno.test("parseRepo handles dots and hyphens", () => {
    const r = parseRepo("my-org/my.repo_name");
    assertEquals(r?.owner, "my-org");
    assertEquals(r?.repo, "my.repo_name");
  }),
  () => Deno.test("TokenExpiredError is instance of Error", () => {
    const e = new TokenExpiredError("test");
    assertEquals(e.name, "TokenExpiredError");
    assertEquals(e instanceof Error, true);
    assertEquals(e.message, "test");
  }),
];

// Register tests when run via `deno test`
for (const run of TEST_RUNNERS) run();

// ─── Server Startup ──────────────────────────────────────────────────────────

const IS_DENO_DEPLOY = !!Deno.env.get("DENO_DEPLOYMENT_ID");

if (import.meta.main && (Deno.args.includes("--serve") || IS_DENO_DEPLOY)) {
  const args = parseArgs(Deno.args, { string: ["client-id", "secret", "port", "callback-url"] });
  const clientId = args["client-id"] || Deno.env.get("GITHUB_CLIENT_ID") || "";
  if (!clientId) {
    console.error("Set GITHUB_CLIENT_ID env var or pass --client-id");
    Deno.exit(1);
  }
  const encryptionKey = await initKey(args.secret || Deno.env.get("SECRET"));
  const ghToken = Deno.env.get("GITHUB_TOKEN");

  const port = Number(args.port || Deno.env.get("PORT") || "8787");
  const resolvedCallbackUrl = (() => {
    if (args["callback-url"]) return args["callback-url"];
    if (Deno.env.get("CALLBACK_URL")) return Deno.env.get("CALLBACK_URL")!;
    if (IS_DENO_DEPLOY) return "https://<auto>/callback";
    return `http://localhost:${port}/callback`;
  })();

  const clientSecret = Deno.env.get("GITHUB_CLIENT_SECRET") || "";
  const app = await createApp({ clientId, clientSecret, callbackUrl: resolvedCallbackUrl, key: encryptionKey, ghToken });

  console.log(`\n🚀 Dashboard → http://localhost:${port}\n`);
  Deno.serve({ port, onListen: () => {} }, app.fetch.bind(app));
}
