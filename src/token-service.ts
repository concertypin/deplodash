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

const consentRecordSchema = z.object({
    repo: z.string().min(1),
    scopes: z.string().min(1),
    granted_at: z.string().min(1),
    agent_id: z.string().optional(),
    requested_scopes: z.string().optional(),
    granted_by: z.string().optional(),
});

// ─── KV prefix helpers ───────────────────────────────────────────────────────

function consentKey(agentId: string, repo: string, scopesHash: string): string {
    return `${CONSENT_PREFIX}${agentId}:${repo}:${scopesHash}`;
}

function tokenCacheKey(
    agentId: string,
    repo: string,
    scopesHash: string
): string {
    return `gh_token:${agentId}:${repo}:${scopesHash}`;
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

    private discardMalformedConsentKey(key: string): void {
        void this.kv.delete(key).catch(() => undefined);
    }

    private parseConsentRecord(
        key: string,
        value: unknown
    ): ConsentRecord | null {
        const parsed = consentRecordSchema.safeParse(value);
        if (!parsed.success) {
            this.discardMalformedConsentKey(key);
            return null;
        }
        return parsed.data as ConsentRecord;
    }

    // ─── Consent ─────────────────────────────────────────────────────────────

    /**
     * Check if consent has been granted for the exact (repo, scopes) combination.
     * Uses hash-based lookup for fast path (cache-friendly).
     */
    async checkConsent(
        agentId: string,
        repo: string,
        scopes: string[]
    ): Promise<boolean> {
        const hash = await hashScopes(scopes);
        const key = consentKey(agentId ?? "", repo, hash);
        const value = await this.kv.get(key, "json");
        if (!value) return false;
        return this.parseConsentRecord(key, value) !== null;
    }

    /**
     * Find stored consent for this repo and compute the intersection of
     * requested vs approved scopes.
     *
     * Supports granular consent: combines all approved scopes across all
     * active consent records for the repo (union), then intersects with
     * what the agent requested.
     *
     * This means if the user approved `contents:read` in one session and
     * `issues:write` in another, an agent requesting both gets both —
     * not just whichever record happens to match best.
     *
     * Returns the effective scope list, or null if no overlap at all
     * (meaning the agent has no usable consent for this repo).
     */
    async findConsentScopes(
        agentId: string,
        repo: string,
        requestedScopes: string[]
    ): Promise<string[] | null> {
        // 1. Try exact hash match first (fast path — saves a KV list scan)
        const exactHash = await hashScopes(requestedScopes);
        const exactKey = consentKey(agentId, repo, exactHash);
        const exactValue = await this.kv.get(exactKey, "json");
        if (exactValue) {
            const record = this.parseConsentRecord(exactKey, exactValue);
            if (!record) return null;
            return record.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }

        // 2. Combine all approved scopes across all consent records (union),
        //    then intersect with what the agent actually requested.
        const approvedScopes = await this.getAllApprovedScopes(agentId, repo);
        const intersection = requestedScopes.filter((s) =>
            approvedScopes.includes(s)
        );

        return intersection.length > 0 ? intersection : null;
    }

    /**
     * Get all distinct approved scopes for a repo across all consent records.
     * Returns an empty array if no consent exists for this repo.
     *
     * Used when the agent's requested scopes don't match — allows the agent
     * to see what IS available and retry with a compatible scope set.
     */
    async getAllApprovedScopes(
        agentId: string,
        repo: string
    ): Promise<string[]> {
        const prefix = `${CONSENT_PREFIX}${agentId}:${repo}:`;
        const entries = await this.kv.list({ prefix });

        const allScopes = new Set<string>();
        for (const entry of entries.keys) {
            const value = await this.kv.get(entry.name, "json");
            if (!value) continue;
            const record = this.parseConsentRecord(entry.name, value);
            if (!record) continue;
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
        agentId: string,
        repo: string,
        scopes: string[],
        requestedScopes?: string[],
        grantedBy?: string
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(agentId, repo, hash);
        const record: ConsentRecord = {
            repo,
            scopes: scopes.join(","),
            granted_at: new Date().toISOString(),
            ...(agentId ? { agent_id: agentId } : {}),
            ...(requestedScopes
                ? { requested_scopes: requestedScopes.join(",") }
                : {}),
            ...(grantedBy ? { granted_by: grantedBy } : {}),
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
                const record = this.parseConsentRecord(batch[j]!.name, value);
                if (!record) continue;
                const entry: ConsentEntry = {
                    repo: record.repo,
                    scopes: record.scopes,
                    granted_at: record.granted_at,
                };
                if (record.granted_by) entry.granted_by = record.granted_by;
                if (record.agent_id) entry.agent_id = record.agent_id;
                if (record.requested_scopes)
                    entry.requested_scopes = record.requested_scopes;
                results.push(entry);
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
    async revokeConsent(
        agentId: string,
        repo: string,
        scopes: string[]
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = consentKey(agentId, repo, hash);
        await this.kv.delete(key);
    }

    /**
     * Revoke all consents for a given repository.
     * Useful when a user wants to revoke all access to a specific repo.
     */
    async revokeAllConsentsForRepo(
        repo: string,
        agentId?: string
    ): Promise<void> {
        const agentPrefix = agentId ? `${agentId}:` : "";
        const consentPrefix = `${CONSENT_PREFIX}${agentPrefix}${repo}:`;
        const tokenPrefix = `gh_token:${agentPrefix}${repo}:`;
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
        agentId: string,
        repo: string,
        scopes: string[]
    ): Promise<CachedToken | null> {
        const hash = await hashScopes(scopes);
        const key = tokenCacheKey(agentId, repo, hash);
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
        agentId: string,
        repo: string,
        scopes: string[],
        token: string,
        expiresAt: string
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const key = tokenCacheKey(agentId, repo, hash);
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
            agentId: string;
        },
        getToken: (
            effectiveScopes: string[]
        ) => Promise<{ token: string; expires_at: string }>
    ): Promise<TokenRequestResult> {
        const { repo, scopes, baseUrl } = params;

        // 1. Check cache for exact requested scopes
        const cached = await this.getCachedToken(params.agentId, repo, scopes);
        if (cached) {
            return {
                status: "ok",
                token: cached.token,
                expires_at: cached.expires_at,
            };
        }

        // 2. Find effective scopes from consent (supports granular approval)
        let effectiveScopes: string[];
        const exactConsent = await this.checkConsent(
            params.agentId,
            repo,
            scopes
        );
        if (exactConsent) {
            effectiveScopes = scopes;
        } else {
            // Try to find a stored consent covering a superset or partial match
            const foundScopes = await this.findConsentScopes(
                params.agentId,
                repo,
                scopes
            );
            if (!foundScopes) {
                const consentUrl =
                    `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                    `&scopes=${encodeURIComponent(scopes.join(","))}`;
                return { status: "needs_consent", url: consentUrl };
            }
            effectiveScopes = foundScopes;
        }

        // 3. Check cache for effective scopes (deep compare — arrays are always !== by reference)
        const sameScopes =
            effectiveScopes.length === scopes.length &&
            effectiveScopes.every((s, i) => s === scopes[i]);
        if (!sameScopes) {
            const effectiveCached = await this.getCachedToken(
                params.agentId,
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
            params.agentId,
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
