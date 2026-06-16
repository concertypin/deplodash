/**
 * Token service — consent management + GitHub token cache via Cloudflare KV.
 *
 * KV key layout:
 *   consent:${repo}:${scopesHash}    → ConsentRecord (generic, per-repo consent)
 *   gh_token:${repo}:${scopesHash}   → CachedToken
 */

import type { ConsentRecord, CachedToken, ConsentEntry } from "@/types";
import { hashScopes } from "@/helpers";
import * as z from "zod";
const dropBufferTime = 5 * 60 * 1000;
const CONSENT_PREFIX = "consent:";

// ─── KV prefix helpers ───────────────────────────────────────────────────────

function consentKey(repo: string, scopesHash: string): string {
    return `${CONSENT_PREFIX}${repo}:${scopesHash}`;
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
     * Also stores repo and scopes in the record for dashboard display.
     */
    async recordConsent(
        repo: string,
        scopes: string[],
        agentId?: string
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        const record: ConsentRecord = {
            repo,
            scopes: scopes.join(","),
            granted_at: new Date().toISOString(),
            ...(agentId ? { agent_id: agentId } : {}),
        };
        await this.kv.put(key, JSON.stringify(record), {
            expirationTtl: 90 * 24 * 3600,
        });
    }

    /**
     * List all consent records in KV.
     * Scans all keys with the `consent:` prefix and returns parsed entries.
     *
     * Note: KV list is eventually consistent — recently written entries may not
     * appear immediately. Returns at most 1000 keys (single page — no cursor
     * pagination implemented yet).
     */
    async listConsents(): Promise<ConsentEntry[]> {
        const entries = await this.kv.list({ prefix: CONSENT_PREFIX });
        const results: ConsentEntry[] = [];

        // Fetch consent records in parallel, batching to stay within Worker subrequest limits
        const BATCH_SIZE = 50;
        for (let i = 0; i < entries.keys.length; i += BATCH_SIZE) {
            const batch = entries.keys.slice(i, i + BATCH_SIZE);
            const values = await Promise.all(
                batch.map((key) => this.kv.get(key.name, "json"))
            );
            for (let j = 0; j < batch.length; j++) {
                const value = values[j];
                if (!value) continue;
                const record = value as Record<string, unknown>;
                // Extract repo and scopes from the stored record
                const repo =
                    typeof record.repo === "string"
                        ? record.repo
                        : (batch[j]!.name.slice(CONSENT_PREFIX.length).split(
                              ":"
                          )[0] ?? "");
                const scopes =
                    typeof record.scopes === "string" ? record.scopes : "";
                const grantedAt =
                    typeof record.granted_at === "string"
                        ? record.granted_at
                        : "";
                if (repo && scopes && grantedAt) {
                    results.push({ repo, scopes, granted_at: grantedAt });
                }
            }
        }

        // Sort by granted_at descending (newest first)
        results.sort(
            (a, b) =>
                new Date(b.granted_at).getTime() -
                new Date(a.granted_at).getTime()
        );

        return results;
    }

    /**
     * Revoke consent for (repo, scopes).
     */
    async revokeConsent(repo: string, scopes: string[]): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        await this.kv.delete(key);
    }

    /**
     * Revoke all consents for a given repository.
     * Useful when a user wants to revoke all access to a specific repo.
     */
    async revokeAllConsentsForRepo(repo: string): Promise<void> {
        const consentPrefix = `${CONSENT_PREFIX}${repo}:`;
        const tokenPrefix = `gh_token:${repo}:`;
        const [consentEntries, tokenEntries] = await Promise.all([
            this.kv.list({ prefix: consentPrefix }),
            this.kv.list({ prefix: tokenPrefix }),
        ]);
        await Promise.all([
            ...consentEntries.keys.map((k) => this.kv.delete(k.name)),
            ...tokenEntries.keys.map((k) => this.kv.delete(k.name)),
        ]);
    }

    // ─── Token caching ───────────────────────────────────────────────────────

    private static readonly kvSchema = z.object({
        token: z.string(),
        expires_at: z.string(),
    });
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
        const cached = TokenService.kvSchema.parse(value);
        // Check if expired (with 5 min buffer)
        const expiresAt = new Date(cached.expires_at).getTime();
        if (expiresAt - dropBufferTime < Date.now()) {
            await this.kv.delete(key);
            return null;
        }
        return cached;
    }

    /**
     * Cache a GitHub Installation Token.
     * Skips caching if the token is too close to expiry (within 5 min + buffer).
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
        const safeUntil = expiresAtMs - dropBufferTime;
        if (safeUntil <= Date.now()) {
            // Token is already too close to expiry (or expired) — don't bother caching
            return;
        }
        const ttl = Math.floor((safeUntil - Date.now()) / 1000);
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
