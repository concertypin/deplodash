/**
 * Token Service — consent management + GitHub token cache via Cloudflare KV.
 *
 * Facade that composes ConsentService and token cache functions.
 */

import { ConsentService } from "@/token/consent-service";
import { getCachedToken, cacheToken } from "@/token/cache";
import type { RepositoryMode } from "@/types";
// ─── Result type ─────────────────────────────────────────────────────────────

export type TokenRequestResult =
    | { status: "ok"; token: string; expires_at: string }
    | { status: "needs_consent"; url: string };

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
            repoMode?: RepositoryMode;
        },
        getToken: (
            effectiveScopes: string[]
        ) => Promise<{ token: string; expires_at: string }>
    ): Promise<TokenRequestResult> {
        const { repo, scopes, baseUrl } = params;
        if (scopes.length === 0) {
            throw new Error("Scopes list cannot be empty");
        }

        const cached = await this.getCachedToken(params.agentId, repo, scopes);
        if (cached) {
            return {
                status: "ok",
                token: cached.token,
                expires_at: cached.expires_at,
            };
        }

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
                return {
                    status: "needs_consent",
                    url: `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}&agent_id=${encodeURIComponent(params.agentId)}&scopes=${encodeURIComponent(scopes.join(","))}&repo_mode=${encodeURIComponent(params.repoMode ?? "existing-only")}`,
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
