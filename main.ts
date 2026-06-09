// deno run --allow-net --allow-env --allow-read main.ts --serve --client-id=xxx
// deno test --allow-net --allow-env --allow-read main.ts
//
// GitHub Deploy Key Dashboard — single-file Deno app (local + Deno Deploy)
//
// ─── Environment Variables ───────────────────────────────────────────────────
//   GITHUB_CLIENT_ID    GitHub OAuth App client ID (required)
//   SECRET              Encryption key for cookie persistence (optional)
//   GITHUB_TOKEN        Direct GitHub token — skips OAuth (optional, dev/testing)
//   CALLBACK_URL        Full callback URL (optional, auto-derived from Host header)
//
// ─── OAuth Setup ─────────────────────────────────────────────────────────────
//   1. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App
//   2. Authorization callback URL → your app's /callback
//      e.g. http://localhost:8787/callback  or  https://my-app.deno.dev/callback
//   3. Copy Client ID → set GITHUB_CLIENT_ID
//
// ─── Local Usage ─────────────────────────────────────────────────────────────
//   export GITHUB_CLIENT_ID=xxx
//   deno run --allow-net --allow-env --allow-read main.ts --serve
//
// ─── Deno Deploy ─────────────────────────────────────────────────────────────
//   Set env vars in the Deno Deploy dashboard, deploy main.ts.
//   SSH public key is entered via the web UI (no PUB_KEY env var needed).

import { Hono } from "npm:hono";
import { logger } from "npm:hono/logger";
import { parseArgs } from "jsr:@std/cli";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding/base64";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

// ─── Custom Errors ───────────────────────────────────────────────────────────

class TokenExpiredError extends Error {
  constructor(msg?: string) {
    super(msg ?? "GitHub token expired or invalid");
    this.name = "TokenExpiredError";
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Repo = {
  readonly full_name: string;
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly private: boolean;
  readonly permissions?: { readonly admin: boolean; readonly push: boolean; readonly pull: boolean };
  readonly html_url: string;
  readonly description: string | null;
};

type DeployKey = { readonly id: number; readonly key: string; readonly title: string; readonly read_only: boolean; readonly verified: boolean };

type RepoStatus = { repo: Repo; keyId: number | null; hasAdmin: boolean };

type AppState = {
  sshKey: string;
  sshKeyTitle: string;
  normalizedKey: string;
  repos: RepoStatus[];
  loadedAt: Date;
  readOnly: boolean;
};

// ─── Pure Helpers ────────────────────────────────────────────────────────────

function normalizeKey(key: string): string {
  return key.trim().split(/\s+/).slice(0, 2).join(" ");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseCookies(header: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    result[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return result;
}

function cookieSet(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict" } = {}): string {
  let c = `${name}=${value}; Path=/`;
  if (opts.httpOnly ?? true) c += "; HttpOnly";
  if (opts.sameSite) c += `; SameSite=${opts.sameSite}`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${opts.maxAge}`;
  return c;
}

function parseRepo(s: string): { owner: string; repo: string } | null {
  const m = s.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ─── Crypto ──────────────────────────────────────────────────────────────────

const KEY_ID = "k1";
type CryptoKeyRef = CryptoKey;

async function initKey(secret?: string): Promise<CryptoKeyRef> {
  if (secret) {
    const salt = new TextEncoder().encode("deploy-key-dashboard-v1");
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits", "deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
}

async function encryptWith(key: CryptoKeyRef, data: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return KEY_ID + "." + encodeBase64(combined);
}

async function decryptWith(key: CryptoKeyRef, packet: string): Promise<string | null> {
  try {
    const dot = packet.indexOf(".");
    if (dot === -1) return null;
    const raw = decodeBase64(packet.slice(dot + 1));
    const iv = raw.slice(0, 12);
    const ciphertext = raw.slice(12);
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decoded);
  } catch {
    return null;
  }
}

// ─── OAuth PKCE ──────────────────────────────────────────────────────────────

async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): string {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

// ─── GitHub API Client ──────────────────────────────────────────────────────

class GitHubClient {
  readonly #token: string;
  readonly #base = "https://api.github.com";

  constructor(token: string) { this.#token = token; }

  async #req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    // 401 → token expired / invalid — surface specially
    if (res.status === 401) {
      throw new TokenExpiredError();
    }

    if (res.status === 204) return undefined as unknown as T;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const remaining = res.headers.get("X-RateLimit-Remaining");
      const reset = res.headers.get("X-RateLimit-Reset");
      let extra = "";
      if (remaining !== null) extra += ` | Remaining: ${remaining}`;
      if (reset !== null) extra += ` | Resets: ${new Date(Number(reset) * 1000).toLocaleTimeString()}`;
      throw new Error(`GitHub ${res.status} ${path}: ${body.slice(0, 500)}${extra}`);
    }
    return res.json() as Promise<T>;
  }

  async listAllRepos(): Promise<Repo[]> {
    const all: Repo[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.#req<Repo[]>(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  listDeployKeys(owner: string, repo: string): Promise<DeployKey[]> {
    return this.#req<DeployKey[]>(`/repos/${owner}/${repo}/keys?per_page=100`);
  }

  addDeployKey(owner: string, repo: string, title: string, key: string, readOnly: boolean): Promise<DeployKey> {
    return this.#req<DeployKey>(`/repos/${owner}/${repo}/keys`, {
      method: "POST",
      body: JSON.stringify({ title, key, read_only: readOnly }),
    });
  }

  removeDeployKey(owner: string, repo: string, keyId: number): Promise<void> {
    return this.#req<void>(`/repos/${owner}/${repo}/keys/${keyId}`, { method: "DELETE" });
  }

  createRepo(name: string, isPrivate: boolean): Promise<Repo> {
    return this.#req<Repo>("/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
    });
  }

  async rateLimit(): Promise<{ remaining: number; limit: number; reset: number }> {
    return (await this.#req<{ rate: { remaining: number; limit: number; reset: number } }>("/rate_limit")).rate;
  }

  async exchangeCode(code: string, verifier: string, clientId: string, redirectUri: string): Promise<string> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`OAuth error: ${data.error_description ?? data.error}`);
    if (!data.access_token) throw new Error("No access_token in OAuth response");
    return data.access_token as string;
  }
}

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

// ─── HTML Templates ──────────────────────────────────────────────────────────

function renderLoginPage(redirectUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy Key Dashboard — Login</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content text-center">
    <div class="max-w-md">
      <div class="mb-6"><i data-lucide="key-round" class="w-16 h-16 mx-auto text-primary"></i></div>
      <h1 class="text-3xl font-bold mb-2">Deploy Key Dashboard</h1>
      <p class="text-base-content/60 mb-8">Manage GitHub deploy keys across all your repositories.</p>
      <a href="${escapeHtml(redirectUrl)}" class="btn btn-primary btn-lg gap-2">
        <i data-lucide="github" class="w-5 h-5"></i>Login with GitHub
      </a>
    </div>
  </div>
</div>
<script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons()</script>
</body>
</html>`;
}

function renderSetupPage(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set Up SSH Key</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content w-full max-w-lg">
    <div class="card bg-base-200 shadow-xl w-full">
      <div class="card-body">
        <h2 class="card-title mb-2">🔑 Enter SSH Public Key</h2>
        <p class="text-sm text-base-content/60 mb-4">Paste the SSH public key that should be registered as a deploy key.</p>
        <textarea id="pubkey" class="textarea textarea-bordered font-mono text-sm w-full h-28" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."></textarea>
        <div id="err" class="text-error text-sm hidden"></div>
        <div class="card-actions justify-end mt-4">
          <button class="btn btn-primary w-full" onclick="submitKey()">Save SSH Key</button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
async function submitKey(){
  const k=document.getElementById("pubkey").value.trim();
  const e=document.getElementById("err");
  if(!k.startsWith("ssh-")){e.textContent="Invalid SSH public key (must start with ssh-...)";e.classList.remove("hidden");return}
  e.classList.add("hidden");
  const r=await fetch("/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pubkey:k})});
  if(r.ok)location.href="/";else{const d=await r.json();e.textContent=d.error||"Error";e.classList.remove("hidden")}
}
document.getElementById("pubkey").addEventListener("keydown",e=>{if(e.key==="Enter"&&e.ctrlKey)submitKey()});
</script>
</body>
</html>`;
}

function renderRegisterPage(params: {
  repo: string; pubkey: string; perm: string; keyName: string;
  error?: string; success?: string;
}): string {
  const { repo, pubkey, perm, keyName, error, success } = params;

  return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Register Deploy Key</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content w-full max-w-lg">
    <div class="card bg-base-200 shadow-xl w-full">
      <div class="card-body">
        <h2 class="card-title mb-2">🔑 Register Deploy Key</h2>

        ${success ? `<div role="alert" class="alert alert-success mb-4"><span>✅ ${escapeHtml(success)}</span></div>` : ""}
        ${error ? `<div role="alert" class="alert alert-error mb-4"><span>❌ ${escapeHtml(error)}</span></div>` : ""}

        <div class="flex flex-col gap-3">
          <label class="form-control w-full">
            <div class="label"><span class="label-text">Repository</span></div>
            <input id="f-repo" type="text" class="input input-bordered w-full font-mono text-sm"
                   value="${escapeHtml(repo)}" placeholder="owner/repo" ${success ? "disabled" : ""}>
          </label>
          <label class="form-control w-full">
            <div class="label"><span class="label-text">SSH Public Key</span></div>
            <textarea id="f-pubkey" class="textarea textarea-bordered font-mono text-sm w-full h-24"
                      ${success ? "disabled" : ""}>${escapeHtml(pubkey)}</textarea>
          </label>
          <label class="form-control w-full">
            <div class="label"><span class="label-text">Permission</span></div>
            <select id="f-perm" class="select select-bordered w-full" ${success ? "disabled" : ""}>
              <option value="RW" ${perm === "RW" || perm === "" ? "selected" : ""}>Read / Write</option>
              <option value="RO" ${perm === "RO" ? "selected" : ""}>Read Only</option>
            </select>
          </label>
          <label class="form-control w-full">
            <div class="label"><span class="label-text">Key Name</span></div>
            <input id="f-keyname" type="text" class="input input-bordered w-full"
                   value="${escapeHtml(keyName || "nanobot")}" ${success ? "disabled" : ""}>
          </label>
        </div>

        <div class="card-actions justify-end mt-4 gap-2">
          ${success
      ? `<a href="/" class="btn btn-primary">Go to Dashboard</a>`
      : `<button class="btn btn-primary flex-1" onclick="doRegister()"><i data-lucide="key-round" class="w-4 h-4"></i> Register Key</button>
               <a href="/" class="btn btn-ghost">Cancel</a>`
    }
        </div>
      </div>
    </div>
  </div>
</div>
<script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons()</script>
${success ? "" : `
<script>
async function doRegister(){
  const b=document.querySelector(".btn-primary");
  b.disabled=true;b.innerHTML='<span class="loading loading-spinner loading-xs"></span> Registering…';
  try{
    const r=await fetch("/api/register",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        repo:document.getElementById("f-repo").value.trim(),
        pubkey:document.getElementById("f-pubkey").value.trim(),
        perm:document.getElementById("f-perm").value,
        keyName:document.getElementById("f-keyname").value.trim()
      })
    });
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Request failed");
    const u=new URL(location.href);
    u.searchParams.set("_result","ok");
    u.searchParams.set("_full_name",d.full_name||"");
    location.href=u.toString();
  }catch(e){
    const u=new URL(location.href);
    u.searchParams.set("_result","err");
    u.searchParams.set("_msg",e.message);
    location.href=u.toString();
  }
}
</script>`}
</body>
</html>`;
}

function renderRow(s: RepoStatus, readOnly: boolean): string {
  const { repo, keyId, hasAdmin } = s;
  const owner = escapeHtml(repo.owner.login);
  const name = escapeHtml(repo.name);
  const dataStatus = !hasAdmin ? "noaccess" : keyId !== null ? "keyed" : "unkeyed";

  const visiBadge = repo.private
    ? `<div class="badge badge-outline gap-1"><i data-lucide="lock" class="w-3 h-3"></i>Private</div>`
    : `<div class="badge badge-success badge-outline gap-1"><i data-lucide="globe" class="w-3 h-3"></i>Public</div>`;

  let statusBadge: string;
  let actionCell: string;

  if (!hasAdmin) {
    statusBadge = `<div class="badge badge-ghost gap-1"><i data-lucide="shield-off" class="w-3 h-3"></i>No admin</div>`;
    actionCell = `<span class="text-base-content/30 text-sm">—</span>`;
  } else if (keyId !== null) {
    statusBadge = `<div class="badge badge-success gap-1"><i data-lucide="check-circle-2" class="w-3 h-3"></i>Registered</div>`;
    actionCell = `<button class="btn btn-xs btn-error btn-outline gap-1" onclick="removeKey(this)"><i data-lucide="trash-2" class="w-3 h-3"></i>Remove</button>`;
  } else {
    statusBadge = `<div class="badge badge-warning gap-1"><i data-lucide="circle-dashed" class="w-3 h-3"></i>No key</div>`;
    actionCell = `<button class="btn btn-xs btn-success btn-outline gap-1" onclick="addKey(this)"><i data-lucide="plus" class="w-3 h-3"></i>Add Key</button>`;
  }

  const desc = repo.description
    ? `<div class="text-xs text-base-content/40 mt-0.5 truncate max-w-sm">${escapeHtml(repo.description.slice(0, 90))}</div>`
    : "";

  return `<tr class="${!hasAdmin ? "opacity-40" : ""}"
    data-name="${owner}/${name}" data-owner="${owner}" data-repo="${name}"
    data-status="${dataStatus}" data-key-id="${keyId ?? ""}">
  <td>
    <a href="${escapeHtml(repo.html_url)}" target="_blank" rel="noopener" class="link link-hover link-primary font-medium">${name}</a>
    <span class="text-base-content/40 text-sm"> / ${owner}</span>${desc}
  </td>
  <td>${visiBadge}</td>
  <td class="status-cell">${statusBadge}</td>
  <td class="action-cell">${actionCell}</td>
</tr>`;
}

function renderDashboard(state: AppState): string {
  const { sshKey, sshKeyTitle, repos, loadedAt, readOnly } = state;
  const keyType = sshKey.split(" ")[0] ?? "ssh";
  const keyComment = escapeHtml(sshKey.split(" ")[2] ?? "");

  const total = repos.length;
  const keyed = repos.filter((r) => r.keyId !== null).length;
  const unkeyed = repos.filter((r) => r.hasAdmin && r.keyId === null).length;
  const noAccess = repos.filter((r) => !r.hasAdmin).length;

  return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy Key Dashboard</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="navbar bg-base-200 shadow-sm px-6 gap-3 sticky top-0 z-10 flex-wrap min-h-14">
  <i data-lucide="key-round" class="w-5 h-5 text-primary shrink-0"></i>
  <span class="text-base font-bold">Deploy Key Dashboard</span>
  <div class="flex items-center gap-2 ml-2">
    <kbd class="kbd kbd-sm font-mono text-base-content/50 hidden md:inline">${escapeHtml(keyType)} ${keyComment}</kbd>
    <button class="btn btn-xs btn-ghost" onclick="document.getElementById('key-modal').showModal()">
      <i data-lucide="pencil" class="w-3 h-3"></i>
    </button>
  </div>
  <span class="ml-auto text-xs text-base-content/40 hidden sm:block">Loaded ${loadedAt.toLocaleTimeString()}</span>
  <button class="btn btn-sm btn-primary gap-1" onclick="document.getElementById('create-modal').showModal()">
    <i data-lucide="plus-circle" class="w-4 h-4"></i>New Repo
  </button>
  <a href="/auth/logout" class="btn btn-sm btn-ghost gap-1"><i data-lucide="log-out" class="w-4 h-4"></i>Logout</a>
</div>
<main class="max-w-6xl mx-auto px-6 py-6">
  <div class="stats shadow w-full mb-6 bg-base-200">
    <div class="stat">
      <div class="stat-figure text-info"><i data-lucide="git-branch" class="w-8 h-8"></i></div>
      <div class="stat-title">Total repos</div>
      <div class="stat-value text-info">${total}</div>
    </div>
    <div class="stat">
      <div class="stat-figure text-success"><i data-lucide="check-circle-2" class="w-8 h-8"></i></div>
      <div class="stat-title">Key registered</div>
      <div class="stat-value text-success" id="cnt-keyed">${keyed}</div>
    </div>
    <div class="stat">
      <div class="stat-figure text-warning"><i data-lucide="circle-dashed" class="w-8 h-8"></i></div>
      <div class="stat-title">No key</div>
      <div class="stat-value text-warning" id="cnt-unkeyed">${unkeyed}</div>
    </div>
    <div class="stat">
      <div class="stat-figure text-base-content/30"><i data-lucide="shield-off" class="w-8 h-8"></i></div>
      <div class="stat-title">No admin access</div>
      <div class="stat-value text-base-content/40">${noAccess}</div>
    </div>
  </div>
  <div class="flex gap-3 mb-4 flex-wrap items-center">
    <label class="input input-bordered flex items-center gap-2 flex-1 min-w-48 max-w-sm">
      <i data-lucide="search" class="w-4 h-4 shrink-0 opacity-40"></i>
      <input id="search" type="text" class="grow" placeholder="Search repositories…" oninput="filterRows()" autocomplete="off">
    </label>
    <div class="join flex-wrap">
      <button class="join-item btn btn-sm btn-active" data-filter="all"      onclick="setFilter(this)">All <span class="badge badge-sm ml-1">${total}</span></button>
      <button class="join-item btn btn-sm"            data-filter="keyed"    onclick="setFilter(this)">Keyed <span class="badge badge-sm badge-success ml-1">${keyed}</span></button>
      <button class="join-item btn btn-sm"            data-filter="unkeyed"  onclick="setFilter(this)">No Key <span class="badge badge-sm badge-warning ml-1">${unkeyed}</span></button>
      <button class="join-item btn btn-sm"            data-filter="noaccess" onclick="setFilter(this)">No Access <span class="badge badge-sm ml-1">${noAccess}</span></button>
    </div>
    <button class="btn btn-sm btn-ghost gap-2" onclick="location.reload()"><i data-lucide="refresh-cw" class="w-4 h-4"></i>Refresh</button>
    <label class="flex items-center gap-2 cursor-pointer">
      <span class="text-sm font-medium">RO</span>
      <input type="checkbox" class="toggle toggle-sm ${readOnly ? "" : "toggle-primary"}"
             ${readOnly ? "" : "checked"}
             onchange="fetch('/api/rw-toggle',{method:'POST',body:this.checked?'0':'1'}).then(()=>location.reload())">
      <span class="text-sm font-medium">RW</span>
    </label>
  </div>
  <div class="overflow-x-auto rounded-xl border border-base-300">
    <table class="table table-sm table-zebra">
      <thead><tr><th>Repository</th><th class="w-28">Visibility</th><th class="w-36">Deploy Key</th><th class="w-28">Actions</th></tr></thead>
      <tbody id="tbody">${repos.map((r) => renderRow(r, readOnly)).join("\n")}</tbody>
    </table>
    <div id="empty-state" class="hidden py-16 text-center text-base-content/40">No repositories match.</div>
  </div>
</main>
<dialog id="key-modal" class="modal">
  <div class="modal-box">
    <form method="dialog"><button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button></form>
    <h3 class="text-lg font-bold mb-4">🔑 SSH Public Key</h3>
    <textarea id="key-editor" class="textarea textarea-bordered font-mono text-sm w-full h-28">${escapeHtml(sshKey)}</textarea>
    <div id="key-err" class="text-error text-sm hidden"></div>
    <div class="card-actions justify-end mt-4">
      <button class="btn btn-primary" onclick="updateKey()">Update Key</button>
    </div>
  </div>
</dialog>
<dialog id="create-modal" class="modal">
  <div class="modal-box">
    <form method="dialog"><button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button></form>
    <h3 class="text-lg font-bold mb-4"><i data-lucide="plus-circle" class="w-5 h-5 inline"></i> Create New Repository</h3>
    <div class="flex flex-col gap-3">
      <label class="form-control w-full">
        <div class="label"><span class="label-text">Repository name</span></div>
        <input id="new-repo-name" type="text" class="input input-bordered w-full" placeholder="my-new-repo" autocomplete="off" onkeydown="if(event.key==='Enter')createRepo()">
      </label>
      <label class="form-control w-full">
        <div class="label"><span class="label-text">Visibility</span></div>
        <select id="new-repo-visibility" class="select select-bordered w-full">
          <option value="private">Private</option><option value="public">Public</option>
        </select>
      </label>
      <div class="flex gap-4 mt-2">
        <button class="btn btn-primary flex-1 gap-1" onclick="createRepo()"><i data-lucide="plus" class="w-4 h-4"></i> Create & Register Key</button>
        <form method="dialog"><button class="btn btn-ghost">Cancel</button></form>
      </div>
      <div id="create-status" class="text-sm mt-2"></div>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
<div id="toast" class="toast toast-end hidden z-50">
  <div id="toast-inner" class="alert shadow-lg">
    <i data-lucide="check-circle-2" id="toast-icon" class="w-4 h-4 shrink-0"></i>
    <span id="toast-msg"></span>
  </div>
</div>
<script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js"></script>
<script>
"use strict"; lucide.createIcons();
let activeFilter="all";
function setFilter(b){activeFilter=b.dataset.filter;document.querySelectorAll("[data-filter]").forEach(x=>x.classList.remove("btn-active"));b.classList.add("btn-active");filterRows()}
function filterRows(){const q=document.getElementById("search").value.toLowerCase();let v=0;document.querySelectorAll("#tbody tr").forEach(r=>{const s=(!q||r.dataset.name.includes(q))&&(activeFilter==="all"||r.dataset.status===activeFilter);r.style.display=s?"":"none";if(s)v++});document.getElementById("empty-state").classList.toggle("hidden",v>0)}
let tt;
function toast(m,t){const w=document.getElementById("toast"),i=document.getElementById("toast-inner"),n=document.getElementById("toast-icon"),x=document.getElementById("toast-msg");x.textContent=m;i.className="alert shadow-lg "+(t==="err"?"alert-error":"alert-success");n.setAttribute("data-lucide",t==="err"?"x-circle":"check-circle-2");lucide.createIcons();w.classList.remove("hidden");clearTimeout(tt);tt=setTimeout(()=>w.classList.add("hidden"),3500)}
function adj(k,u){const a=document.getElementById("cnt-keyed"),b=document.getElementById("cnt-unkeyed");a.textContent=Math.max(0,+a.textContent+k);b.textContent=Math.max(0,+b.textContent+u)}
async function updateKey(){const k=document.getElementById("key-editor").value.trim(),e=document.getElementById("key-err");if(!k.startsWith("ssh-")){e.textContent="Invalid key";e.classList.remove("hidden");return}e.classList.add("hidden");const r=await fetch("/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pubkey:k})});if(r.ok){document.getElementById("key-modal").close();location.reload()}else{const d=await r.json();e.textContent=d.error||"Error";e.classList.remove("hidden")}}
async function addKey(b){const r=b.closest("tr"),{owner,repo}=r.dataset;b.disabled=true;b.innerHTML='<span class="loading loading-spinner loading-xs"></span>Adding…';try{const f=await fetch("/api/repos/"+owner+"/"+repo+"/keys",{method:"POST"}),d=await f.json();if(!f.ok)throw new Error(d.error||"Request failed");r.dataset.status="keyed";r.dataset.keyId=d.id;r.querySelector(".status-cell").innerHTML='<div class="badge badge-success gap-1"><i data-lucide="check-circle-2" class="w-3 h-3"></i>Registered</div>';const nb=document.createElement("button");nb.className="btn btn-xs btn-error btn-outline gap-1";nb.innerHTML='<i data-lucide="trash-2" class="w-3 h-3"></i>Remove';nb.onclick=()=>removeKey(nb);b.replaceWith(nb);lucide.createIcons();adj(1,-1);toast("Key registered on "+owner+"/"+repo);if(activeFilter!=="all")filterRows()}catch(e){toast(e.message,"err");b.disabled=false;b.innerHTML='<i data-lucide="plus" class="w-3 h-3"></i>Add Key';lucide.createIcons()}}
async function removeKey(b){const r=b.closest("tr"),{owner,repo,keyId}=r.dataset;if(!confirm("Remove deploy key from "+owner+"/"+repo+"?"))return;b.disabled=true;b.innerHTML='<span class="loading loading-spinner loading-xs"></span>';try{const f=await fetch("/api/repos/"+owner+"/"+repo+"/keys/"+keyId,{method:"DELETE"});if(!f.ok){const d=await f.json();throw new Error(d.error||"Request failed")}r.dataset.status="unkeyed";r.dataset.keyId="";r.querySelector(".status-cell").innerHTML='<div class="badge badge-warning gap-1"><i data-lucide="circle-dashed" class="w-3 h-3"></i>No key</div>';const nb=document.createElement("button");nb.className="btn btn-xs btn-success btn-outline gap-1";nb.innerHTML='<i data-lucide="plus" class="w-3 h-3"></i>Add Key';nb.onclick=()=>addKey(nb);b.replaceWith(nb);lucide.createIcons();adj(-1,1);toast("Key removed from "+owner+"/"+repo);if(activeFilter!=="all")filterRows()}catch(e){toast(e.message,"err");b.disabled=false;b.innerHTML='<i data-lucide="trash-2" class="w-3 h-3"></i>Remove';lucide.createIcons()}}
async function createRepo(){const n=document.getElementById("new-repo-name").value.trim();if(!n){toast("Enter a repository name","err");return}if(!/^[a-zA-Z0-9._-]+$/.test(n)){toast("Invalid repo name","err");return}const p=document.getElementById("new-repo-visibility").value==="private",b=document.querySelector("#create-modal .btn-primary"),s=document.getElementById("create-status");b.disabled=true;b.innerHTML='<span class="loading loading-spinner loading-xs"></span> Creating…';s.textContent="";try{const f=await fetch("/api/repos",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,private:p})}),d=await f.json();if(!f.ok)throw new Error(d.error||"Request failed");s.innerHTML='<span class="text-success">✅ '+d.full_name+' created and key registered!</span>';setTimeout(()=>location.reload(),1500)}catch(e){s.innerHTML='<span class="text-error">❌ '+e.message+'</span>';b.disabled=false;b.innerHTML='<i data-lucide="plus" class="w-4 h-4"></i> Create & Register Key';lucide.createIcons()}}
</script>
</body>
</html>`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("normalizeKey strips comment and trims", () => {
  assertEquals(normalizeKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr nanobot-risuai"),
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr");
});
Deno.test("normalizeKey handles multiple spaces", () => {
  assertEquals(normalizeKey("  ssh-rsa   AAAAB3NzaC1yc2EAAAADAQABAAABAQDC  comment  "), "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDC");
});
Deno.test("normalizeKey handles minimal key", () => {
  assertEquals(normalizeKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5");
});
Deno.test("normalizeKey is idempotent", () => {
  const k = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr";
  assertEquals(normalizeKey(k), k);
  assertEquals(normalizeKey(normalizeKey(k + "   extra")), k);
});
Deno.test("escapeHtml escapes special chars", () => {
  assertEquals(escapeHtml("<script>alert(\"xss\")</script>"), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
});
Deno.test("escapeHtml escapes & first", () => {
  assertEquals(escapeHtml("a&b"), "a&amp;b");
  assertEquals(escapeHtml("&amp;"), "&amp;amp;");
});
Deno.test("escapeHtml passes safe strings", () => {
  assertEquals(escapeHtml("hello"), "hello");
  assertEquals(escapeHtml(""), "");
});
Deno.test("parseCookies parses header", () => {
  const c = parseCookies("a=1; b=hello; gh_token=xyz");
  assertEquals(c.a, "1");
  assertEquals(c.gh_token, "xyz");
});
Deno.test("parseCookies handles empty", () => {
  assertEquals(parseCookies(null), {});
  assertEquals(parseCookies(""), {});
});
Deno.test("cookieSet produces valid cookie", () => {
  const c = cookieSet("x", "y");
  assertStringIncludes(c, "x=y");
  assertStringIncludes(c, "HttpOnly");
  assertStringIncludes(c, "Path=/");
});
Deno.test("cookieSet supports SameSite", () => {
  assertStringIncludes(cookieSet("x", "y", { sameSite: "Lax" }), "SameSite=Lax");
});
Deno.test("base64UrlEncode produces URL-safe output", () => {
  const r = base64UrlEncode(new TextEncoder().encode("hello"));
  assertEquals(r.includes("+"), false);
  assertEquals(r.includes("/"), false);
  assertEquals(r.includes("="), false);
});
Deno.test("encrypt/decrypt roundtrip", async () => {
  const key = await initKey("test-secret");
  const p = await encryptWith(key, "gho_sampletoken123");
  assertEquals(typeof p, "string");
  assertStringIncludes(p, ".");
  assertEquals(await decryptWith(key, p), "gho_sampletoken123");
});
Deno.test("decrypt garbage returns null", async () => {
  const key = await initKey("test-secret");
  assertEquals(await decryptWith(key, "invalid.format"), null);
});
Deno.test("decrypt tampered returns null", async () => {
  const key = await initKey("test-secret");
  const p = await encryptWith(key, "token123");
  // Flip a bit in the ciphertext portion (after the ".")
  const dot = p.indexOf(".");
  const prefix = p.slice(0, dot + 1);
  const b64 = [...p.slice(dot + 1)];
  b64[0] = b64[0] === "A" ? "B" : "A"; // guaranteed different base64 char
  const t = prefix + b64.join("");
  assertEquals(await decryptWith(key, t), null);
});
Deno.test("randomBytes URL-safe", () => {
  const r = randomBytes(32);
  assertEquals(r.includes("+"), false);
  assertEquals(r.includes("/"), false);
  assertEquals(r.length > 0, true);
});
Deno.test("pkceChallenge works", async () => {
  const c = await pkceChallenge(randomBytes(32));
  assertEquals(c.includes("="), false);
  assertEquals(c.length > 0, true);
});
Deno.test("parseRepo extracts owner/repo", () => {
  const r = parseRepo("concertypin/my-repo");
  assertEquals(r?.owner, "concertypin");
  assertEquals(r?.repo, "my-repo");
});
Deno.test("parseRepo rejects invalid", () => {
  assertEquals(parseRepo(""), null);
  assertEquals(parseRepo("no-slash"), null);
  assertEquals(parseRepo("/leading-slash"), null);
});
Deno.test("parseRepo handles dots and hyphens", () => {
  const r = parseRepo("my-org/my.repo_name");
  assertEquals(r?.owner, "my-org");
  assertEquals(r?.repo, "my.repo_name");
});
Deno.test("TokenExpiredError is instance of Error", () => {
  const e = new TokenExpiredError("test");
  assertEquals(e.name, "TokenExpiredError");
  assertEquals(e instanceof Error, true);
  assertEquals(e.message, "test");
});

// ─── App Factory ─────────────────────────────────────────────────────────────

async function createApp(config: {
  clientId: string;
  callbackUrl: string;
  key: CryptoKeyRef;
  ghToken?: string;
}) {
  const { clientId, callbackUrl, key: encryptionKey, ghToken } = config;
  const AUTH_COOKIE = "gh_token";
  const SSH_COOKIE = "ssh_key";

  const app = new Hono();
  app.use("*", logger());

  // ── Auth middleware ─────────────────────────────────────────────────
  // Exempt: login page, OAuth endpoints, SSH key setup, GET /register (shows form)
  app.use("*", async (c: any, next: () => Promise<void>) => {
    const path: string = c.req.path;
    const method: string = c.req.method;

    // Paths that never require auth
    if (path === "/login" || path === "/auth/github" || path === "/callback" || path === "/setup") {
      await next();
      return;
    }
    // GET /register — shows form without auth. POST uses /api/register (authed).
    if (path === "/register" && method === "GET") {
      await next();
      return;
    }

    const cookies = parseCookies(c.req.header("cookie"));
    const tokenPacket = cookies[AUTH_COOKIE];
    if (tokenPacket) {
      const token = await decryptWith(encryptionKey, decodeURIComponent(tokenPacket));
      if (token) {
        c.set("gh_token", token);
        const keyPacket = cookies[SSH_COOKIE];
        if (keyPacket) {
          const sshKey = await decryptWith(encryptionKey, decodeURIComponent(keyPacket));
          if (sshKey) c.set("ssh_key", sshKey);
        }
        await next();
        return;
      }
    }

    // API routes → JSON 401 instead of HTML redirect (fetch needs JSON)
    if (path.startsWith("/api/")) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    // Preserve original URL through login flow via ?next=
    const qs = new URL(c.req.url).search;
    const returnTo = encodeURIComponent(qs ? path + qs : path);
    return c.redirect("/login?next=" + returnTo);
  });

  // ── Global error handler ───────────────────────────────────────────
  // Catches TokenExpiredError thrown from any GitHub API call → auto re-auth
  app.onError((err, c) => {
    if (err instanceof TokenExpiredError) {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "GitHub token expired", code: "TOKEN_EXPIRED" }, 401);
      }
      // For page requests, clear cookie and redirect
      c.header("Set-Cookie", cookieSet(AUTH_COOKIE, "", { maxAge: 0 }));
      return c.redirect("/login");
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  let currentReadOnly = false;

  function getClient(c: any): GitHubClient {
    return new GitHubClient(ghToken ?? c.get("gh_token") as string);
  }

  function getSshKey(c: any): string | undefined {
    return c.get("ssh_key") as string | undefined;
  }

  // ── Auth Routes ────────────────────────────────────────────────────

  app.get("/login", (c) => {
    const host = c.req.header("host") || "localhost";
    const scheme = host === "localhost" ? "http" : "https";
    const next = c.req.query("next") || "/";
    const redirectUri = `${scheme}://${host}/callback`;
    const oauthUrl = `${scheme}://${host}/auth/github?redirect_uri=${encodeURIComponent(redirectUri)}&next=${encodeURIComponent(next)}`;
    return c.html(renderLoginPage(oauthUrl));
  });

  app.get("/auth/github", async (c) => {
    const verifier = randomBytes(64);
    const stateNonce = randomBytes(32);
    const challenge = await pkceChallenge(verifier);
    const next = c.req.query("next") || "/";
    const redirectUri = c.req.query("redirect_uri") || callbackUrl;
    const encryptedState = await encryptWith(encryptionKey, JSON.stringify({ v: verifier, s: stateNonce, n: next, r: redirectUri }));
    const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(encryptedState)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&scope=repo`;
    return c.redirect(url);
  });

  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const err = c.req.query("error");
    if (err) return c.html(`<h1>OAuth error: ${escapeHtml(err)}</h1>`);
    if (!code || !stateParam) return c.html(`<h1>Missing code or state</h1>`);

    try {
      const payload = JSON.parse(await decryptWith(encryptionKey, decodeURIComponent(stateParam)) ?? "{}") as { v?: string; n?: string; r?: string };
      if (!payload.v) throw new Error("Invalid state payload");
      const redirectUri = payload.r || callbackUrl;
      const tempClient = new GitHubClient("");
      const accessToken = await tempClient.exchangeCode(code, payload.v, clientId, redirectUri);
      const encrypted = await encryptWith(encryptionKey, accessToken);
      c.header("Set-Cookie", cookieSet(AUTH_COOKIE, encodeURIComponent(encrypted), { maxAge: 86400 * 30, sameSite: "Lax" }));
      return c.redirect(payload.n || "/");
    } catch (e) {
      return c.html(`<h1>Auth failed</h1><p>${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`);
    }
  });

  app.get("/auth/logout", (c) => {
    c.header("Set-Cookie", [
      cookieSet(AUTH_COOKIE, "", { maxAge: 0 }),
      cookieSet(SSH_COOKIE, "", { maxAge: 0 }),
    ].join("; "));
    return c.redirect("/login");
  });

  // ── SSH Key Setup ──────────────────────────────────────────────────

  app.get("/setup", (c) => c.html(renderSetupPage()));

  app.post("/setup", async (c) => {
    const { pubkey } = await c.req.json<{ pubkey: string }>();
    if (!pubkey || !pubkey.trim().startsWith("ssh-")) {
      return c.json({ error: "Invalid SSH public key" }, 400);
    }
    const encrypted = await encryptWith(encryptionKey, pubkey.trim());
    c.header("Set-Cookie", cookieSet(SSH_COOKIE, encodeURIComponent(encrypted), { maxAge: 86400 * 30, sameSite: "Lax" }));
    return c.json({ ok: true });
  });

  // ── Quick Register (form, no auth required for GET) ───────────────

  app.get("/register", (c) => {
    const repo = c.req.query("repo") || "";
    const pubkey = c.req.query("pubkey") || "";
    const perm = c.req.query("perm") || "RW";
    const keyName = c.req.query("key_name") || "nanobot";
    const result = c.req.query("_result");
    const msg = c.req.query("_msg");
    const fullName = c.req.query("_full_name");

    if (result === "ok" && fullName) {
      return c.html(renderRegisterPage({ repo, pubkey, perm, keyName, success: `Key registered on ${fullName}` }));
    }
    if (result === "err" && msg) {
      return c.html(renderRegisterPage({ repo, pubkey, perm, keyName, error: msg }));
    }
    return c.html(renderRegisterPage({ repo, pubkey, perm, keyName }));
  });

  // ── API Routes (auth required via middleware) ─────────────────────

  app.post("/api/register", async (c) => {
    const { repo, pubkey, perm, keyName } = await c.req.json<{ repo: string; pubkey: string; perm: string; keyName: string }>();
    const parsed = parseRepo(repo);
    if (!parsed) return c.json({ error: "Invalid repo format (expected owner/repo)" }, 400);
    if (!pubkey || !pubkey.trim().startsWith("ssh-")) return c.json({ error: "Invalid SSH public key" }, 400);
    if (!keyName) return c.json({ error: "keyName is required" }, 400);

    const readOnly = perm === "RO";
    try {
      const token: string | undefined = ghToken ?? (c as any).get("gh_token");
      if (!token) return c.json({ error: "Not authenticated" }, 401);
      const client = new GitHubClient(token);
      const key = await client.addDeployKey(parsed.owner, parsed.repo, keyName, pubkey.trim(), readOnly);
      return c.json({ id: key.id, full_name: `${parsed.owner}/${parsed.repo}` });
    } catch (e) {
      // TokenExpiredError is caught by onError handler → 401 with TOKEN_EXPIRED code
      if (e instanceof TokenExpiredError) throw e;
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get("/", async (c) => {
    const sshKey = getSshKey(c);
    if (!sshKey) return c.redirect("/setup");

    const client = getClient(c);
    const normalizedKey = normalizeKey(sshKey);
    const repos = await loadRepoStatuses(client, normalizedKey);

    const state: AppState = {
      sshKey,
      sshKeyTitle: "deploy-key",
      normalizedKey,
      repos,
      loadedAt: new Date(),
      readOnly: currentReadOnly,
    };
    return c.html(renderDashboard(state));
  });

  app.post("/api/rw-toggle", async (c) => {
    const body = await c.req.text();
    currentReadOnly = body.trim() === "0" ? false : true;
    return c.json({ readOnly: currentReadOnly });
  });

  app.post("/api/repos/:owner/:repo/keys", async (c) => {
    const { owner, repo } = c.req.param();
    const sshKey = getSshKey(c);
    if (!sshKey) return c.json({ error: "No SSH key configured" }, 400);
    try {
      const client = getClient(c);
      const key = await client.addDeployKey(owner, repo, "deploy-key", sshKey, currentReadOnly);
      return c.json({ id: key.id, title: key.title, read_only: key.read_only });
    } catch (e) {
      if (e instanceof TokenExpiredError) throw e;
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.delete("/api/repos/:owner/:repo/keys/:keyId", async (c) => {
    const { owner, repo, keyId } = c.req.param();
    try {
      const client = getClient(c);
      await client.removeDeployKey(owner, repo, Number(keyId));
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof TokenExpiredError) throw e;
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/repos", async (c) => {
    const { name, private: isPrivate } = await c.req.json<{ name: string; private: boolean }>();
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return c.json({ error: "Invalid repo name" }, 400);
    const sshKey = getSshKey(c);
    if (!sshKey) return c.json({ error: "No SSH key configured" }, 400);
    try {
      const client = getClient(c);
      const repo = await client.createRepo(name, isPrivate ?? true);
      await client.addDeployKey(repo.owner.login, repo.name, "deploy-key", sshKey, currentReadOnly);
      return c.json({ full_name: repo.full_name });
    } catch (e) {
      if (e instanceof TokenExpiredError) throw e;
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  return app;
}

// ─── Server Startup ──────────────────────────────────────────────────────────

const IS_DENO_DEPLOY = !!Deno.env.get("DENO_DEPLOYMENT_ID");

if (import.meta.main && (Deno.args.includes("--serve") || IS_DENO_DEPLOY)) {
  const args = parseArgs(Deno.args, {
    string: ["client-id", "secret", "port", "callback-url"],
    default: { port: "8787" },
  });

  const clientId = args["client-id"] || Deno.env.get("GITHUB_CLIENT_ID") || "";
  const userSecret = args.secret || Deno.env.get("SECRET") || undefined;
  const ghToken = Deno.env.get("GITHUB_TOKEN") || undefined;
  const callbackUrl = args["callback-url"] || Deno.env.get("CALLBACK_URL") || "";
  const port = Number(args.port);

  if (!clientId) {
    console.error("\n❌ GITHUB_CLIENT_ID is required (env var or --client-id)\n");
    Deno.exit(1);
  }

  console.log("🔑 Initializing encryption key…");
  if (userSecret) console.log("   (user secret — cookies survive restart)");
  else console.log("   (ephemeral — cookies lost on restart. Use --secret for persistence)");
  const encryptionKey = await initKey(userSecret);

  const resolvedCallbackUrl = callbackUrl || (() => {
    if (IS_DENO_DEPLOY) {
      console.warn("   ⚠️  CALLBACK_URL not set — using Host header");
      return "https://<auto>/callback";
    }
    return `http://localhost:${port}/callback`;
  })();

  const app = await createApp({ clientId, callbackUrl: resolvedCallbackUrl, key: encryptionKey, ghToken });

  console.log(`\n🚀 Dashboard → http://localhost:${port}\n`);
  Deno.serve({ port }, app.fetch);
}
