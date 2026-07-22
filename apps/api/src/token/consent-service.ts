/**
 * Consent Service — consent record management via Cloudflare KV.
 *
 * KV key layout:
 *   consent:${agentId}:${repo}:${scopesHash}    → ConsentRecord
 *
 * Handles check, find, record, list, revoke operations.
 */

import type { ConsentRecord, ConsentEntry, RepositoryMode } from "@/types";
import { hashScopes } from "@/github/scopes";
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
    return `${CONSENT_PREFIX}${agentId}:${repo}:${scopesHash}`;
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
        const key = consentKey(agentId ?? "", repo, hash);
        const value = await this.kv.get(key, "json");
        if (!value) return false;
        return this.parseConsentRecord(key, value) !== null;
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

        const prefix = `${CONSENT_PREFIX}${agentId}:${repo}:`;
        const entries = await this.kv.list({ prefix });

        // Collect the latest record per scope, sorted by key (contains timestamp).
        // KV keys contain a scopesHash so we iterate all records for this repo+agent.
        const scopeMode = new Map<string, RepositoryMode>();

        for (const entry of entries.keys) {
            const value = await this.kv.get(entry.name, "json");
            if (!value) continue;
            const record = this.parseConsentRecord(entry.name, value);
            if (!record) continue;

            const storedMode: RepositoryMode =
                record.repo_mode ?? "existing-only";

            for (const scope of record.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)) {
                // Only keep the latest (first encountered due to KV key ordering or overwrite the first)
                if (!scopeMode.has(scope)) {
                    scopeMode.set(scope, storedMode);
                }
            }
        }

        // Every effective scope must resolve to "create-if-missing"
        for (const scope of effectiveScopes) {
            const mode = scopeMode.get(scope);
            if (mode !== "create-if-missing") return "existing-only";
        }

        return "create-if-missing";
    }

    // ─── Write ───────────────────────────────────────────────────────────────

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
        const key = consentKey(agentId, repo, hash);

        if (caller) {
            const value = await this.kv.get(key, "json");
            if (value) {
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

        await this.kv.delete(key);
        // Clean up legacy-format key too
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
            const agentPrefix = `${CONSENT_PREFIX}${agentId}:${repo}:`;
            const tokenPrefix = `gh_token_v2:${agentId}:${repo}:`;
            const [consentEntries, tokenEntries] = await Promise.all([
                this.kv.list({ prefix: agentPrefix }),
                this.kv.list({ prefix: tokenPrefix }),
            ]);
            consentKeysToDelete.push(...consentEntries.keys.map((k) => k.name));
            tokenKeysToDelete.push(...tokenEntries.keys.map((k) => k.name));
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
                if (parts.length >= 2 && parts[parts.length - 2] === repo) {
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
