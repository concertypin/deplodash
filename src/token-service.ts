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
     * Check if consent has been granted for the exact (repo, scopes) combination.
     * Uses hash-based lookup for fast path (cache-friendly).
     */
    async checkConsent(repo: string, scopes: string[]): Promise<boolean> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        const value = await this.kv.get(key, "json");
        return value !== null;
    }

    /**
     * Find stored consent for this repo and compute the intersection of
     * requested vs approved scopes.
     *
     * Supports granular consent: if the user approved only a subset
     * (e.g. contents:write + issues:read) but the agent requested more
     * (e.g. contents:write + administration:write), this returns the
     * intersection — what was both requested AND approved.
     *
     * Returns the effective scope list, or null if no overlap at all
     * (meaning the agent has no usable consent for this repo).
     */
    async findConsentScopes(
        repo: string,
        requestedScopes: string[]
    ): Promise<string[] | null> {
        // 1. Try exact hash match first (fast path — saves a KV list scan)
        const exactHash = await hashScopes(requestedScopes);
        const exactKey = consentKey(repo, exactHash);
        const exactValue = await this.kv.get(exactKey, "json");
        if (exactValue) {
            const record = exactValue as ConsentRecord;
            return record.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }

        // 2. Scan all consents for this repo to find the best overlap
        const prefix = `${CONSENT_PREFIX}${repo}:`;
        const entries = await this.kv.list({ prefix });

        let bestMatch: string[] | null = null;

        for (const entry of entries.keys) {
            const value = await this.kv.get(entry.name, "json");
            if (!value) continue;
            const record = value as ConsentRecord;
            const approvedScopes = record.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);

            // Compute intersection: what the agent requested AND the user approved
            const intersection = requestedScopes.filter((s) =>
                approvedScopes.includes(s)
            );

            // Pick the record with the most matching scopes
            if (
                intersection.length > 0 &&
                (!bestMatch || intersection.length > bestMatch.length)
            ) {
                bestMatch = intersection;
            }
        }

        return bestMatch;
    }

    /**
     * Get all distinct approved scopes for a repo across all consent records.
     * Returns an empty array if no consent exists for this repo.
     *
     * Used when the agent's requested scopes don't match — allows the agent
     * to see what IS available and retry with a compatible scope set.
     */
    async getAllApprovedScopes(repo: string): Promise<string[]> {
        const prefix = `${CONSENT_PREFIX}${repo}:`;
        const entries = await this.kv.list({ prefix });

        const allScopes = new Set<string>();
        for (const entry of entries.keys) {
            const value = await this.kv.get(entry.name, "json");
            if (!value) continue;
            const record = value as ConsentRecord;
            for (const s of record.scopes
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean)) {
                allScopes.add(s);
            }
        }

        return [...allScopes];
    }

    /**
     * Record consent for (repo, scopes). Valid for 90 days.
     * Also stores repo and scopes in the record for dashboard display.
     */
    async recordConsent(
        repo: string,
        scopes: string[],
        agentId?: string,
        requestedScopes?: string[]
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(repo, hash);
        const record: ConsentRecord = {
            repo,
            scopes: scopes.join(","),
            granted_at: new Date().toISOString(),
            ...(agentId ? { agent_id: agentId } : {}),
            ...(requestedScopes
                ? { requested_scopes: requestedScopes.join(",") }
                : {}),
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
                const requestedScopes =
                    typeof record.requested_scopes === "string"
                        ? record.requested_scopes
                        : undefined;
                if (repo && scopes && grantedAt) {
                    const entry: ConsentEntry = {
                        repo,
                        scopes,
                        granted_at: grantedAt,
                    };
                    if (requestedScopes)
                        entry.requested_scopes = requestedScopes;
                    results.push(entry);
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
        getToken: (
            effectiveScopes: string[]
        ) => Promise<{ token: string; expires_at: string }>
    ): Promise<TokenRequestResult> {
        const { repo, scopes, baseUrl } = params;

        // 1. Check cache for exact requested scopes
        const cached = await this.getCachedToken(repo, scopes);
        if (cached) {
            return {
                status: "ok",
                token: cached.token,
                expires_at: cached.expires_at,
            };
        }

        // 2. Find effective scopes from consent (supports granular approval)
        let effectiveScopes: string[];
        const exactConsent = await this.checkConsent(repo, scopes);
        if (exactConsent) {
            effectiveScopes = scopes;
        } else {
            // Try to find a stored consent covering a superset or partial match
            const foundScopes = await this.findConsentScopes(repo, scopes);
            if (!foundScopes) {
                const consentUrl =
                    `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                    `&scopes=${encodeURIComponent(scopes.join(","))}`;
                return { status: "needs_consent", url: consentUrl };
            }
            effectiveScopes = foundScopes;
        }

        // 3. Check cache for effective scopes
        if (effectiveScopes !== scopes) {
            const effectiveCached = await this.getCachedToken(
                repo,
                effectiveScopes
            );
            if (effectiveCached) {
                return {
                    status: "ok",
                    token: effectiveCached.token,
                    expires_at: effectiveCached.expires_at,
                };
            }
        }

        // 4. Fetch token with effective scopes (the approved subset)
        const result = await getToken(effectiveScopes);
        await this.cacheToken(
            repo,
            effectiveScopes,
            result.token,
            result.expires_at
        );
        return {
            status: "ok",
            token: result.token,
            expires_at: result.expires_at,
        };
    }
}
