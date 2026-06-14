/**
 * Token service — consent management + GitHub token cache via Cloudflare KV.
 *
 * KV key layout:
 *   consent:${repo}:${scopesHash}    → ConsentRecord (generic, per-repo consent)
 *   gh_token:${repo}:${scopesHash}   → CachedToken
 */

import type { ConsentRecord, CachedToken } from "@/types";
import { hashScopes } from "@/helpers";

// ─── KV prefix helpers ───────────────────────────────────────────────────────

function consentKey(repo: string, scopesHash: string): string {
    return `consent:${repo}:${scopesHash}`;
}

function tokenCacheKey(repo: string, scopesHash: string): string {
    return `gh_token:${repo}:${scopesHash}`;
}

// ─── Result type ─────────────────────────────────────────────────────────────

export type TokenRequestResult =
    | { status: "ok"; token: string; expires_at: string }
    | { status: "needs_consent"; url: string };

// ─── Token Service ───────────────────────────────────────────────────────────

export class TokenService {
    private kv: KVNamespace;

    constructor(kv: KVNamespace) {
        this.kv = kv;
    }

    // ─── Consent ─────────────────────────────────────────────────────────────

    /**
     * Check if consent has been granted for (repo, scopes).
     */
    async checkConsent(repo: string, scopes: string[]): Promise<boolean> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        const value = await this.kv.get(key, "json");
        return value !== null;
    }

    /**
     * Record consent for (repo, scopes). Valid for 90 days.
     */
    async recordConsent(repo: string, scopes: string[]): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        const record: ConsentRecord = { granted_at: new Date().toISOString() };
        await this.kv.put(key, JSON.stringify(record), {
            expirationTtl: 90 * 24 * 3600,
        });
    }

    /**
     * Revoke consent for (repo, scopes).
     */
    async revokeConsent(repo: string, scopes: string[]): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        await this.kv.delete(key);
    }

    // ─── Token caching ───────────────────────────────────────────────────────

    /**
     * Retrieve a cached token for (repo, scopes), or null if not cached / expired.
     */
    async getCachedToken(
        repo: string,
        scopes: string[]
    ): Promise<CachedToken | null> {
        const hash = await hashScopes(scopes);
        const key = tokenCacheKey(repo, hash);
        const value = await this.kv.get(key, "json");
        if (!value) return null;
        const cached = value as CachedToken;
        // Check if expired (with 5 min buffer)
        const expiresAt = new Date(cached.expires_at).getTime();
        if (expiresAt - 5 * 60 * 1000 < Date.now()) {
            await this.kv.delete(key);
            return null;
        }
        return cached;
    }

    /**
     * Cache a GitHub Installation Token.
     */
    async cacheToken(
        repo: string,
        scopes: string[],
        token: string,
        expiresAt: string
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = tokenCacheKey(repo, hash);
        const cached: CachedToken = { token, expires_at: expiresAt };
        // Cache until 5 min before actual expiry, with max 1 hour TTL
        const expiresAtMs = new Date(expiresAt).getTime();
        const ttl = Math.max(
            60,
            Math.floor((expiresAtMs - Date.now() - 5 * 60 * 1000) / 1000)
        );
        await this.kv.put(key, JSON.stringify(cached), {
            expirationTtl: Math.min(ttl, 3600),
        });
    }

    // ─── High-level flow ────────────────────────────────────────────────────

    /**
     * Attempt to get a token for the given agent + repo + scopes.
     *
     * 1. Check cache first.
     * 2. If no cache, check consent (generic, per-repo).
     * 3. If consent exists, fetch and cache a new token.
     * 4. If no consent, return needs_consent URL for user approval.
     *
     * @param getToken - Callback that actually fetches the token from GitHub App API.
     */
    async requestToken(
        params: {
            repo: string;
            scopes: string[];
            baseUrl: string;
        },
        getToken: () => Promise<{ token: string; expires_at: string }>
    ): Promise<TokenRequestResult> {
        const { repo, scopes, baseUrl } = params;

        // 1. Check cache
        const cached = await this.getCachedToken(repo, scopes);
        if (cached) {
            return {
                status: "ok",
                token: cached.token,
                expires_at: cached.expires_at,
            };
        }

        // 2. Check consent
        const hasConsent = await this.checkConsent(repo, scopes);
        if (!hasConsent) {
            const consentUrl =
                `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                `&scopes=${encodeURIComponent(scopes.join(","))}`;
            return { status: "needs_consent", url: consentUrl };
        }

        // 3. Fetch & cache
        const result = await getToken();
        await this.cacheToken(repo, scopes, result.token, result.expires_at);
        return {
            status: "ok",
            token: result.token,
            expires_at: result.expires_at,
        };
    }
}
