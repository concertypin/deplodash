/**
 * GitHub App — JWT signing + Installation Token issuance.
 *
 * Environment variables (via Env bindings):
 *   GITHUB_APP_ID            GitHub App ID (required)
 *   GITHUB_APP_PRIVATE_KEY   PEM-encoded RSA private key (required)
 *   GITHUB_INSTALLATION_ID   Installation ID (required)
 *
 * Uses Web Crypto API (native in Cloudflare Workers) for RS256 JWT signing.
 */

import type { ScopePreset } from "@/types";
import { z } from "zod";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Schema for the GitHub App Installation Token API response.
 * Used for runtime validation instead of type assertions.
 */
const installationTokenResponseSchema = z.object({
    token: z.string(),
    expires_at: z.string(),
    permissions: z.record(z.string(), z.string()),
    repository_selection: z.string(),
});

export interface InstallationToken {
    token: string;
    expires_at: string; // ISO 8601
    permissions: Record<string, string>;
    repositorySelection: string;
}

// ─── Scope Presets ───────────────────────────────────────────────────────────

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

/**
 * Convert a scope array to a GitHub permissions object.
 */
export function permissionsFromScopes(
    scopes: string[]
): Record<string, string> {
    const key = [...scopes].sort().join("+") as ScopePreset;
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

// ─── PEM → CryptoKey ─────────────────────────────────────────────────────────

/**
 * Parse a PEM-encoded RSA private key and import it as a CryptoKey for RS256 signing.
 *
 * Accepts two formats:
 *   1. Raw PEM (-----BEGIN ... -----) — multiline or single-line, with or without headers.
 *   2. Base64-encoded body only — single line, handy for `.dev.vars` which doesn't support multiline values.
 *
 * Auto-detects by checking if the input starts with "-----BEGIN".
 */
async function pemToCryptoKey(pem: string): Promise<CryptoKey> {
    let base64: string;
    if (pem.startsWith("-----BEGIN")) {
        // Raw PEM — extract base64 body, ignoring header attributes like Proc-Type, DEK-Info etc.
        const match =
            /-----BEGIN\s+[\w-]+-----\s*(?:(?:[\w-]+:\s*[^\n]*\n)*\n?\s*)?([A-Za-z0-9+/=\s]+)\s*-----END\s+[\w-]+-----/.exec(
                pem
            );
        if (!match)
            throw new Error("PEM? I barely know 'em. Check your key format.");
        base64 = match[1]!.replace(/\s/g, "");
    } else {
        // Assume it's already base64-encoded body (no headers/footers) — for .dev.vars convenience
        base64 = pem.replace(/\s/g, "");
    }
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey(
        "pkcs8",
        raw,
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: { name: "SHA-256" },
        },
        false,
        ["sign"]
    );
}

// ─── JWT Helpers ─────────────────────────────────────────────────────────────

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function encodeJSON(obj: Record<string, unknown>): string {
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Sign a JWT using RS256 with the given private key.
 */
async function signJwt(privateKey: CryptoKey, appId: string): Promise<string> {
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iat: now,
        exp: now + 600, // 10 minutes
        iss: appId,
    };
    const headerB64 = encodeJSON(header);
    const payloadB64 = encodeJSON(payload);
    const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        privateKey,
        message
    );
    return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

// ─── GitHub App Service ───────────────────────────────────────────────────────

export class GitHubApp {
    private appId: string;
    private installationId: string;
    private keyPromise: Promise<CryptoKey>;

    constructor(appId: string, installationId: string, privateKeyPem: string) {
        this.appId = appId;
        this.installationId = installationId;
        this.keyPromise = pemToCryptoKey(privateKeyPem);
    }

    /**
     * Sign a fresh JWT (10 min expiry).
     * No caching needed — each HTTP request creates a new GitHubApp instance.
     */
    private async getJwt(): Promise<string> {
        const key = await this.keyPromise;
        return signJwt(key, this.appId);
    }

    /**
     * Exchange the App JWT for an Installation Token scoped to the given permissions.
     */
    async getInstallationToken(
        permissions: Record<string, string>
    ): Promise<InstallationToken> {
        const jwt = await this.getJwt();
        const url = `https://api.github.com/app/installations/${this.installationId}/access_tokens`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${jwt}`,
                "User-Agent": "deplodash/1.0",
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ permissions }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(
                `GitHub App token request failed: ${res.status} ${body.slice(0, 500)}`
            );
        }
        const ghResponse = installationTokenResponseSchema.parse(
            await res.json()
        );
        return {
            token: ghResponse.token,
            expires_at: ghResponse.expires_at,
            permissions: ghResponse.permissions,
            repositorySelection: ghResponse.repository_selection,
        };
    }

    /**
     * Request an installation token for a specific set of scope strings.
     * Convenience wrapper around getInstallationToken.
     */
    async requestToken(scopes: string[]): Promise<InstallationToken> {
        const perms = permissionsFromScopes(scopes);
        return this.getInstallationToken(perms);
    }

    /**
     * Ensure a repository exists. If it doesn't, create it using the
     * GitHub App installation's admin permissions.
     *
     * @returns true if the repo already existed or was created successfully.
     */
    async ensureRepoExists(owner: string, repo: string): Promise<boolean> {
        // 1. Get installation token with admin permission
        const adminToken = await this.getInstallationToken({
            administration: "write",
        });

        // 2. Check if repo already exists
        const checkRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
            {
                headers: {
                    Authorization: `Bearer ${adminToken.token}`,
                    "User-Agent": "deplodash/1.0",
                },
            }
        );
        if (checkRes.status === 200) return true;
        if (checkRes.status !== 404) {
            const body = await checkRes.text().catch(() => "");
            throw new Error(
                `Failed to check repo existence: ${checkRes.status} ${body.slice(0, 200)}`
            );
        }

        // 3. Determine if owner is an org or user
        const orgRes = await fetch(`https://api.github.com/orgs/${owner}`, {
            headers: {
                Authorization: `Bearer ${adminToken.token}`,
                "User-Agent": "deplodash/1.0",
            },
        });
        const isOrg = orgRes.status === 200;

        // 4. Create the repo
        const createUrl = isOrg
            ? `https://api.github.com/orgs/${owner}/repos`
            : `https://api.github.com/user/repos`;

        const createRes = await fetch(createUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${adminToken.token}`,
                "User-Agent": "deplodash/1.0",
                "Content-Type": "application/json",
                Accept: "application/vnd.github+json",
            },
            body: JSON.stringify({
                name: repo,
                private: true,
                auto_init: false,
            }),
        });

        if (!createRes.ok) {
            const body = await createRes.text().catch(() => "");
            throw new Error(
                `Failed to create repo ${owner}/${repo}: ${createRes.status} ${body.slice(0, 300)}`
            );
        }

        return true;
    }
}
