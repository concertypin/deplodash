/**
 * Token Service — consent management + GitHub token cache via Cloudflare KV.
 *
 * Facade that composes ConsentService and token cache functions.
 */

import { ConsentService } from "@/token/consent-service";
import { getCachedToken, cacheToken } from "@/token/cache";
import { encryptWith, getOrInitKey } from "@/crypto";
import type { RepositoryMode } from "@/types";
// ─── Result type ─────────────────────────────────────────────────────────────

export type TokenRequestResult =
    | { status: "ok"; token: string; expires_at: string }
    | { status: "needs_consent"; url: string; requested_scopes_enc?: string };

// ─── Token Service ───────────────────────────────────────────────────────────

export class TokenService {
    private consentService: ConsentService;
    private kv: KVNamespace;

    constructor(kv: KVNamespace) {
        this.kv = kv;
        this.consentService = new ConsentService(kv);
    }

    // ─── Consent methods (delegated) ─────────────────────────────────────────

    /** @see ConsentService.checkConsent */
    checkConsent(
        agentId: string,
        repo: string,
        scopes: string[]
    ): Promise<boolean> {
        return this.consentService.checkConsent(agentId, repo, scopes);
    }

    /** @see ConsentService.findConsentScopes */
    findConsentScopes(
        agentId: string,
        repo: string,
        requestedScopes: string[]
    ): Promise<string[] | null> {
        return this.consentService.findConsentScopes(
            agentId,
            repo,
            requestedScopes
        );
    }

    /** @see ConsentService.getAllApprovedScopes */
    getAllApprovedScopes(agentId: string, repo: string): Promise<string[]> {
        return this.consentService.getAllApprovedScopes(agentId, repo);
    }

    /** @see ConsentService.recordConsent */
    recordConsent(
        agentId: string,
        repo: string,
        scopes: string[],
        requestedScopes?: string[],
        grantedBy?: string,
        repoMode: RepositoryMode = "existing-only"
    ): Promise<void> {
        return this.consentService.recordConsent(
            agentId,
            repo,
            scopes,
            requestedScopes,
            grantedBy,
            repoMode
        );
    }

    /** @see ConsentService.listConsents */
    listConsents(grantedBy?: string) {
        return this.consentService.listConsents(grantedBy);
    }

    /** @see ConsentService.getConsentRepositoryMode */
    getConsentRepositoryMode(
        agentId: string,
        repo: string,
        effectiveScopes: string[]
    ): Promise<RepositoryMode> {
        return this.consentService.getConsentRepositoryMode(
            agentId,
            repo,
            effectiveScopes
        );
    }

    /** @see ConsentService.revokeConsent */
    revokeConsent(
        agentId: string,
        repo: string,
        scopes: string[],
        caller?: string
    ): Promise<void> {
        return this.consentService.revokeConsent(agentId, repo, scopes, caller);
    }

    /** @see ConsentService.revokeAllConsentsForRepo */
    revokeAllConsentsForRepo(repo: string, agentId?: string): Promise<void> {
        return this.consentService.revokeAllConsentsForRepo(repo, agentId);
    }

    // ─── Token caching ───────────────────────────────────────────────────────

    /** @see getCachedToken */
    getCachedToken(agentId: string, repo: string, scopes: string[]) {
        return getCachedToken(this.kv, agentId, repo, scopes);
    }

    /** @see cacheToken */
    cacheToken(
        agentId: string,
        repo: string,
        scopes: string[],
        token: string,
        expiresAt: string
    ): Promise<void> {
        return cacheToken(this.kv, agentId, repo, scopes, token, expiresAt);
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
            encryptionSecret?: string;
            repoMode?: RepositoryMode;
            repoExists?: boolean;
        },
        getToken: (
            effectiveScopes: string[]
        ) => Promise<{ token: string; expires_at: string }>
    ): Promise<TokenRequestResult> {
        const { repo, scopes, baseUrl, encryptionSecret } = params;
        if (scopes.length === 0) {
            throw new Error("Scopes list cannot be empty");
        }

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
            const foundScopes = await this.findConsentScopes(
                params.agentId,
                repo,
                scopes
            );
            if (!foundScopes) {
                let consentUrl =
                    `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                    `&scopes=${encodeURIComponent(scopes.join(","))}` +
                    `&agent_id=${encodeURIComponent(params.agentId)}`;

                let requested_scopes_enc: string | undefined;
                if (encryptionSecret) {
                    const key = await getOrInitKey(encryptionSecret);
                    requested_scopes_enc = await encryptWith(
                        key,
                        JSON.stringify({
                            version: 1,
                            purpose: "consent-request",
                            scopes: scopes.join(","),
                            repo,
                            agent_id: params.agentId,
                            repo_mode: params.repoMode ?? "existing-only",
                            repo_exists: params.repoExists ?? true,
                        }),
                        "consent-request"
                    );
                    consentUrl += `&requested_scopes_enc=${encodeURIComponent(requested_scopes_enc)}`;
                }

                // Add repo_mode and repo_exists to the URL for the consent UI
                consentUrl += `&repo_mode=${encodeURIComponent(params.repoMode ?? "existing-only")}`;
                consentUrl += `&repo_exists=${params.repoExists ?? true}`;

                return {
                    status: "needs_consent",
                    url: consentUrl,
                    ...(requested_scopes_enc !== undefined
                        ? { requested_scopes_enc }
                        : {}),
                };
            }
            effectiveScopes = foundScopes;
        }

        // 3. Check cache for effective scopes
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

        // 4. Fetch token with effective scopes
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
