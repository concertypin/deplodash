// deno-lint-ignore-file no-unused-vars
//
// GitHub App — JWT signing + Installation Token issuance
//
// Environment variables:
//   GITHUB_APP_ID            GitHub App ID (required)
//   GITHUB_APP_PRIVATE_KEY   PEM-encoded RSA private key (required)
//   GITHUB_INSTALLATION_ID   Installation ID (required)

/** Response from GitHub's installation token API. */
export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
  repositorySelection: string;
}

/** Scope presets for common permission combinations. */
export type ScopePreset =
  | "contents:read"
  | "contents:write"
  | "contents:write+workflows:write"
  | "admin";

const SCOPE_PRESETS: Record<ScopePreset, Record<string, string>> = {
  "contents:read": { metadata: "read", contents: "read" },
  "contents:write": { metadata: "read", contents: "write" },
  "contents:write+workflows:write": {
    metadata: "read",
    contents: "write",
    workflows: "write",
  },
  admin: {
    metadata: "read",
    contents: "write",
    workflows: "write",
    administration: "write",
  },
};

/** Convert scope strings to GitHub permission object. */
export function permissionsFromScopes(scopes: string[]): Record<string, string> {
  const key = scopes.sort().join("+") as ScopePreset;
  if (SCOPE_PRESETS[key]) return { ...SCOPE_PRESETS[key] };
  const perms: Record<string, string> = { metadata: "read" };
  for (const s of scopes) {
    if (s === "contents:read") perms.contents = "read";
    else if (s === "contents:write") perms.contents = "write";
    else if (s === "workflows:write") perms.workflows = "write";
    else if (s === "admin") return { ...SCOPE_PRESETS.admin };
  }
  return perms;
}

/** Hash scope array for use as a KV key. */
export function hashScopes(scopes: string[]): string {
  return [...scopes].sort().join("+");
}

// ─── Native JS JWT (no npm dependency) ────────────────────────────────────────

const JWT_HEADER = new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...u8))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlEncode(str: string): string {
  return base64url(new TextEncoder().encode(str));
}

/** Import a PEM-encoded PKCS#8 RSA private key for RS256 signing. */
async function importRSAPrivateKey(pem: string): Promise<CryptoKey> {
  const lines = pem.trim().split("\n");
  const base64 = lines
    .filter((l) => !l.startsWith("-----") && !l.startsWith("---"))
    .join("");
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Create a GitHub App JWT valid for 10 minutes. */
async function createJWT(appId: number, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iss: appId, iat: now, exp: now + 600 });
  const key = await importRSAPrivateKey(privateKeyPem);
  const message = `${base64url(JWT_HEADER)}.${base64urlEncode(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(message),
  );
  return `${message}.${base64url(sig)}`;
}

// ─── GitHub App Client ────────────────────────────────────────────────────────

export class GitHubApp {
  #appId: number;
  #privateKey: string;
  #installationId: number;

  constructor(
    appId: string | number,
    privateKey: string,
    installationId: string | number,
  ) {
    this.#appId = typeof appId === "string" ? parseInt(appId, 10) : appId;
    this.#privateKey = privateKey;
    this.#installationId = typeof installationId === "string"
      ? parseInt(installationId, 10)
      : installationId;
  }

  /** Exchange JWT for an installation access token, optionally scoped. */
  async createInstallationToken(
    permissions?: Record<string, string>,
    repos?: string[],
  ): Promise<InstallationToken> {
    const jwt = await createJWT(this.#appId, this.#privateKey);
    const body: Record<string, unknown> = {};
    if (repos && repos.length > 0) body.repositories = repos;
    if (permissions) body.permissions = permissions;

    const res = await fetch(
      `https://api.github.com/app/installations/${this.#installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "deplodash",
        },
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GitHub App token failure (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at),
      permissions: data.permissions ?? {},
      repositorySelection: data.repository_selection ?? "selected",
    };
  }

  /** Convenience: create a scoped token for a single repo. */
  async createScopedToken(repo: string, preset: ScopePreset): Promise<InstallationToken> {
    return this.createInstallationToken(SCOPE_PRESETS[preset], [repo]);
  }

  /** Check if env vars are present. */
  static isConfigured(): boolean {
    return !!(
      Deno.env.get("GITHUB_APP_ID") &&
      Deno.env.get("GITHUB_APP_PRIVATE_KEY") &&
      Deno.env.get("GITHUB_INSTALLATION_ID")
    );
  }

  /** Create from environment variables. */
  static fromEnv(): GitHubApp {
    const appId = Deno.env.get("GITHUB_APP_ID");
    const privateKey = Deno.env.get("GITHUB_APP_PRIVATE_KEY");
    const installationId = Deno.env.get("GITHUB_INSTALLATION_ID");
    if (!appId || !privateKey || !installationId) {
      throw new Error(
        "Missing required env: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID",
      );
    }
    return new GitHubApp(appId, privateKey, installationId);
  }
}
