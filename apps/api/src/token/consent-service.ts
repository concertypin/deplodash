/**
 * Consent Service — consent record management via Cloudflare KV.
 *
 * KV key layout:
 *   consent:${agentId}:${repo}:${scopesHash}    → ConsentRecord
 *
 * Handles check, find, record, list, revoke operations.
 *
 * Repository identity is normalized to lowercase when building keys so a
 * grant recorded as "Owner/Repo" is found by a retry for "owner/repo".
 * Records written before normalization used the original casing; lookups
 * and revocations fall back to that key format so existing grants remain
 * valid and revocable without a migration.
 */

import type { ConsentRecord, ConsentEntry, RepositoryMode } from "@/types";
import { hashScopes } from "@/github/scopes";
import { normalizeRepo } from "@/helpers";
import { ConsentOwnershipError } from "@/errors";
import * as z from "zod";

const CONSENT_PREFIX = "consent:";

const consentRecordSchema = z.object({
    repo: z.string().min(1),
    scopes: z.string().min(1),
    granted_at: z.string().min(1),
    agent_id: z.string().optional(),
    requested_scopes: z.string().optional(),
    granted_by: z.string().optional(),
    repo_mode: z.enum(["existing-only", "create-if-missing"]).optional(),
});

// ─── KV prefix helpers ───────────────────────────────────────────────────────

function consentKey(agentId: string, repo: string, scopesHash: string): string {
    return `${CONSENT_PREFIX}${agentId}:${normalizeRepo(repo)}:${scopesHash}`;
}

/**
 * The original-casing key format used before repo normalization.
 * Kept so consent granted to a mixed-case repository before this change
 * (e.g. "consent:agent:Owner/Repo:<hash>") is still found and revocable.
 */
function consentKeyLegacy(
    agentId: string,
    repo: string,
    scopesHash: string
): string {
    return `${CONSENT_PREFIX}${agentId}:${repo}:${scopesHash}`;
}

/**
 * Exact keys to probe for a consent record, newest format first.
 * The legacy original-casing key is included only when it differs.
 */
function consentLookupKeys(
    agentId: string,
    repo: string,
    scopesHash: string
): string[] {
    const normalized = consentKey(agentId, repo, scopesHash);
    const legacy = consentKeyLegacy(agentId, repo, scopesHash);
    return normalized === legacy ? [normalized] : [normalized, legacy];
}

/**
 * Prefixes to list for repo-scoped queries, newest format first.
 */
function consentLookupPrefixes(agentId: string, repo: string): string[] {
    const normalized = `${CONSENT_PREFIX}${agentId}:${normalizeRepo(repo)}:`;
    const legacy = `${CONSENT_PREFIX}${agentId}:${repo}:`;
    return normalized === legacy ? [normalized] : [normalized, legacy];
}

/**
 * Split a consent key suffix ("<repo>:<scopesHash>") into its parts.
 * The repository portion never contains ":" (repo format is owner/name),
 * so the last colon separates the scope hash.
 */
function splitConsentSuffix(suffix: string): {
    repo: string;
    scopesHash: string;
} {
    const lastColon = suffix.lastIndexOf(":");
    if (lastColon < 0) return { repo: suffix, scopesHash: "" };
    return {
        repo: suffix.slice(0, lastColon),
        scopesHash: suffix.slice(lastColon + 1),
    };
}

// ─── Consent Service ─────────────────────────────────────────────────────────

export class ConsentService {
    private kv: KVNamespace;

    constructor(kv: KVNamespace) {
        this.kv = kv;
    }

    private discardMalformedConsentKey(key: string): void {
        void this.kv.delete(key).catch(() => undefined);
    }

    /**
     * Find consent keys under the agent prefix whose repository portion
     * matches `repo` case-insensitively. Discovers pre-normalization records
     * stored as "consent:<agent>:Owner/Repo:<hash>" even when the current
     * request uses "owner/repo". Optionally filters by scope hash.
     */
    private async findConsentKeysCaseInsensitive(
        agentId: string,
        repo: string,
        scopesHash?: string
    ): Promise<string[]> {
        const prefix = `${CONSENT_PREFIX}${agentId}:`;
        const entries = await this.kv.list({ prefix });
        const target = normalizeRepo(repo);
        const keys: string[] = [];
        for (const entry of entries.keys) {
            const suffix = entry.name.startsWith(prefix)
                ? entry.name.slice(prefix.length)
                : "";
            if (!suffix) continue;
            const { repo: repoPart, scopesHash: hashPart } =
                splitConsentSuffix(suffix);
            if (normalizeRepo(repoPart) !== target) continue;
            if (scopesHash !== undefined && hashPart !== scopesHash) continue;
            keys.push(entry.name);
        }
        return keys;
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
        // Zod parse validates shape; return the parsed data matching ConsentRecord
        return parsed.data satisfies ConsentRecord;
    }

    // ─── Read ────────────────────────────────────────────────────────────────

    /**
     * Check if consent has been granted for the exact (repo, scopes) combination.
     */
    async checkConsent(
        agentId: string,
        repo: string,
        scopes: string[]
    ): Promise<boolean> {
        const hash = await hashScopes(scopes);
        const keys = consentLookupKeys(agentId ?? "", repo, hash);
        for (const key of keys) {
            const value = await this.kv.get(key, "json");
            if (value) return this.parseConsentRecord(key, value) !== null;
        }
        // Fallback: pre-normalization records may use any repo casing.
        const legacyKeys = await this.findConsentKeysCaseInsensitive(
            agentId ?? "",
            repo,
            hash
        );
        for (const key of legacyKeys) {
            const value = await this.kv.get(key, "json");
            if (value) return this.parseConsentRecord(key, value) !== null;
        }
        return false;
    }

    /**
     * Find stored consent scope intersection for requested scopes.
     *
     * 1. Fast path: exact hash match.
     * 2. Union-intersect fallback: combines all approved scopes across records.
     */
    async findConsentScopes(
        agentId: string,
        repo: string,
        requestedScopes: string[]
    ): Promise<string[] | null> {
        const exactHash = await hashScopes(requestedScopes);
        for (const exactKey of consentLookupKeys(agentId, repo, exactHash)) {
            const exactValue = await this.kv.get(exactKey, "json");
            if (exactValue) {
                const record = this.parseConsentRecord(exactKey, exactValue);
                if (!record) return null;
                return record.scopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }
        // Fallback: pre-normalization records may use any repo casing.
        const legacyKeys = await this.findConsentKeysCaseInsensitive(
            agentId,
            repo,
            exactHash
        );
        for (const exactKey of legacyKeys) {
            const exactValue = await this.kv.get(exactKey, "json");
            if (exactValue) {
                const record = this.parseConsentRecord(exactKey, exactValue);
                if (!record) return null;
                return record.scopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }

        const approvedScopes = await this.getAllApprovedScopes(agentId, repo);
        const intersection = requestedScopes.filter((s) =>
            approvedScopes.includes(s)
        );

        return intersection.length > 0 ? intersection : null;
    }

    /**
     * Get all distinct approved scopes for a repo across all consent records.
     */
    async getAllApprovedScopes(
        agentId: string,
        repo: string
    ): Promise<string[]> {
        const prefixes = consentLookupPrefixes(agentId, repo);
        const keyLists = await Promise.all(
            prefixes.map((prefix) => this.kv.list({ prefix }))
        );
        const allKeyNames = keyLists.flatMap((list) =>
            list.keys.map((k) => k.name)
        );
        // Fallback: pre-normalization records may use any repo casing.
        const legacyKeys = await this.findConsentKeysCaseInsensitive(
            agentId,
            repo
        );
        allKeyNames.push(...legacyKeys);
        const seenKeys = new Set<string>();

        const allScopes = new Set<string>();
        for (const keyName of allKeyNames) {
            if (seenKeys.has(keyName)) continue;
            seenKeys.add(keyName);
            const value = await this.kv.get(keyName, "json");
            if (!value) continue;
            const record = this.parseConsentRecord(keyName, value);
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

    // ─── Repository Mode ──────────────────────────────────────────────────────

    /**
     * Resolve the repository mode from stored consent records for the given
     * effective scopes. Returns "create-if-missing" only when EVERY effective
     * scope's latest consent record has that mode. Any legacy record without
     * repo_mode, mixed modes, malformed data, or an unresolved scope returns
     * "existing-only".
     */
    async getConsentRepositoryMode(
        agentId: string,
        repo: string,
        effectiveScopes: string[]
    ): Promise<RepositoryMode> {
        if (effectiveScopes.length === 0) return "existing-only";

        const prefixes = consentLookupPrefixes(agentId, repo);
        const keyLists = await Promise.all(
            prefixes.map((prefix) => this.kv.list({ prefix }))
        );
        const allKeyNames = keyLists.flatMap((list) =>
            list.keys.map((k) => k.name)
        );
        // Fallback: pre-normalization records may use any repo casing.
        const legacyKeys = await this.findConsentKeysCaseInsensitive(
            agentId,
            repo
        );
        allKeyNames.push(...legacyKeys);
        const seenKeys = new Set<string>();

        // Keep the newest record per scope. KV key order is lexical by hash,
        // not chronological, so granted_at is the source of truth.
        const scopeMode = new Map<
            string,
            { mode: RepositoryMode; grantedAt: string }
        >();

        for (const keyName of allKeyNames) {
            if (seenKeys.has(keyName)) continue;
            seenKeys.add(keyName);
            const value = await this.kv.get(keyName, "json");
            if (!value) continue;
            const record = this.parseConsentRecord(keyName, value);
            if (!record) continue;

            const storedMode: RepositoryMode =
                record.repo_mode ?? "existing-only";

            for (const scope of record.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)) {
                const current = scopeMode.get(scope);
                if (!current || record.granted_at > current.grantedAt) {
                    scopeMode.set(scope, {
                        mode: storedMode,
                        grantedAt: record.granted_at,
                    });
                }
            }
        }

        // Every effective scope must resolve to "create-if-missing"
        for (const scope of effectiveScopes) {
            const mode = scopeMode.get(scope)?.mode;
            if (mode !== "create-if-missing") return "existing-only";
        }

        return "create-if-missing";
    }

    /**
     * Record consent for (agentId, repo, scopes). Valid for 90 days.
     */
    async recordConsent(
        agentId: string,
        repo: string,
        scopes: string[],
        requestedScopes?: string[],
        grantedBy?: string,
        repoMode: RepositoryMode = "existing-only"
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
            repo_mode: repoMode,
        };
        await this.kv.put(key, JSON.stringify(record), {
            expirationTtl: 90 * 24 * 3600,
        });
    }

    // ─── List ────────────────────────────────────────────────────────────────

    /**
     * List all consent records. When `grantedBy` is provided, filters to
     * entries with matching `granted_by`.
     */
    async listConsents(grantedBy?: string): Promise<ConsentEntry[]> {
        const entries = await this.kv.list({ prefix: CONSENT_PREFIX });
        const results: ConsentEntry[] = [];

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

                if (grantedBy) {
                    if (!record.granted_by || record.granted_by !== grantedBy) {
                        continue;
                    }
                }

                const entry: ConsentEntry = {
                    repo: record.repo,
                    scopes: record.scopes,
                    granted_at: record.granted_at,
                };
                if (record.granted_by) entry.granted_by = record.granted_by;
                if (record.agent_id !== undefined)
                    entry.agent_id = record.agent_id;
                if (record.requested_scopes)
                    entry.requested_scopes = record.requested_scopes;
                if (record.repo_mode) entry.repo_mode = record.repo_mode;
                results.push(entry);
            }
        }

        results.sort(
            (a, b) =>
                new Date(b.granted_at).getTime() -
                new Date(a.granted_at).getTime()
        );

        return results;
    }

    // ─── Revoke ──────────────────────────────────────────────────────────────

    /**
     * Revoke consent for (agentId, repo, scopes).
     * When `caller` is provided, checks ownership before deleting.
     */
    async revokeConsent(
        agentId: string,
        repo: string,
        scopes: string[],
        caller?: string
    ): Promise<void> {
        const hash = await hashScopes(scopes);
        const keys = consentLookupKeys(agentId, repo, hash);
        // Fallback: pre-normalization records may use any repo casing.
        const legacyKeys = await this.findConsentKeysCaseInsensitive(
            agentId,
            repo,
            hash
        );
        const allKeys = [...new Set([...keys, ...legacyKeys])];

        if (caller) {
            // Check ownership on whichever key format holds the record.
            for (const key of allKeys) {
                const value = await this.kv.get(key, "json");
                if (!value) continue;
                const record = this.parseConsentRecord(key, value);
                if (
                    record &&
                    record.granted_by &&
                    record.granted_by !== caller
                ) {
                    throw new ConsentOwnershipError();
                }
            }
        }

        for (const key of allKeys) {
            await this.kv.delete(key);
        }
        // Clean up legacy-format key too (no agentId)
        await this.kv.delete(`${CONSENT_PREFIX}${repo}:${hash}`);
    }

    /**
     * Revoke all consents for a repo. Scoped to `agentId` if provided.
     */
    async revokeAllConsentsForRepo(
        repo: string,
        agentId?: string
    ): Promise<void> {
        const consentKeysToDelete: string[] = [];
        const tokenKeysToDelete: string[] = [];

        if (agentId) {
            const consentPrefixes = consentLookupPrefixes(agentId, repo);
            const tokenPrefixes = consentPrefixes.map((prefix) =>
                prefix.replace(CONSENT_PREFIX, "gh_token_v2:")
            );
            const [consentEntries, tokenEntries] = await Promise.all([
                Promise.all(
                    consentPrefixes.map((prefix) => this.kv.list({ prefix }))
                ),
                Promise.all(
                    tokenPrefixes.map((prefix) => this.kv.list({ prefix }))
                ),
            ]);
            for (const entries of consentEntries) {
                consentKeysToDelete.push(...entries.keys.map((k) => k.name));
            }
            for (const entries of tokenEntries) {
                tokenKeysToDelete.push(...entries.keys.map((k) => k.name));
            }
            // Fallback: pre-normalization records may use any repo casing.
            const legacyConsentKeys = await this.findConsentKeysCaseInsensitive(
                agentId,
                repo
            );
            for (const name of legacyConsentKeys) {
                consentKeysToDelete.push(name);
                const tokenKey = name.replace(CONSENT_PREFIX, "gh_token_v2:");
                tokenKeysToDelete.push(tokenKey);
            }
        } else {
            const allEntries = await this.kv.list({
                prefix: CONSENT_PREFIX,
            });
            for (const key of allEntries.keys) {
                const name = key.name;
                const suffix = name.startsWith(CONSENT_PREFIX)
                    ? name.slice(CONSENT_PREFIX.length)
                    : "";
                if (!suffix) continue;
                // Suffix format: agentId:repo:scopesHash
                const parts = suffix.split(":");
                const repoPart = parts[parts.length - 2];
                if (
                    repoPart &&
                    normalizeRepo(repoPart) === normalizeRepo(repo)
                ) {
                    consentKeysToDelete.push(name);
                    const tokenKey = name.replace(
                        CONSENT_PREFIX,
                        "gh_token_v2:"
                    );
                    tokenKeysToDelete.push(tokenKey);
                }
            }
        }

        await Promise.all([
            ...consentKeysToDelete.map((k) => this.kv.delete(k)),
            ...tokenKeysToDelete.map((k) => this.kv.delete(k)),
        ]);
    }
}
