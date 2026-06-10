// Token service — consent management + GitHub token cache via Deno KV.
//
// Deno KV key layout:
//   ["user_consent", userId, repo, scopesHash] → { granted_at }
//   ["gh_token", repo, scopesHash]             → { token, expires_at }

import { hashScopes, permissionsFromScopes } from "./github-app.ts";
import type { GitHubApp, InstallationToken, ScopePreset } from "./github-app.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConsentRecord {
  granted_at: Date;
}

export interface CachedGitHubToken {
  token: string;
  expires_at: Date;
}

export interface TokenRequestParams {
  repo: string;
  scopes: string[];
}

export type TokenRequestResult =
  | { status: "ok"; token: string; expires_at: string }
  | { status: "needs_consent"; url: string };

// ─── KV prefixes ──────────────────────────────────────────────────────────────

const CONSENT_PREFIX = ["user_consent"];
const GH_TOKEN_CACHE_PREFIX = ["gh_token"];

// ─── Service ──────────────────────────────────────────────────────────────────

export class TokenService {
  #kv: Deno.Kv;
  #githubApp: GitHubApp;
  /** Base URL for constructing consent links. */
  baseUrl: string;

  constructor(kv: Deno.Kv, githubApp: GitHubApp, baseUrl: string) {
    this.#kv = kv;
    this.#githubApp = githubApp;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ─── Consent ─────────────────────────────────────────────────────────────

  /** Check if a user has granted consent for (repo, scopes). */
  async checkConsent(
    userId: number,
    repo: string,
    scopes: string[],
  ): Promise<boolean> {
    const key = [...CONSENT_PREFIX, userId, repo, hashScopes(scopes)];
    const entry = await this.#kv.get<ConsentRecord>(key);
    return entry.value !== null;
  }

  /** Record a user's consent for (repo, scopes). */
  async recordConsent(
    userId: number,
    repo: string,
    scopes: string[],
  ): Promise<void> {
    const key = [...CONSENT_PREFIX, userId, repo, hashScopes(scopes)];
    await this.#kv.set(key, { granted_at: new Date() } satisfies ConsentRecord);
  }

  /** Build the consent URL for a token request. */
  buildConsentUrl(repo: string, scopes: string[], redirectToken: string): string {
    const params = new URLSearchParams({
      repo,
      scopes: scopes.join(","),
      token: redirectToken,
    });
    return `${this.baseUrl}/auth/consent?${params}`;
  }

  // ─── GitHub token cache ──────────────────────────────────────────────────

  /** Try to get a cached GitHub token that hasn't expired. */
  async getCachedToken(
    repo: string,
    scopes: string[],
  ): Promise<string | null> {
    const key = [...GH_TOKEN_CACHE_PREFIX, repo, hashScopes(scopes)];
    const entry = await this.#kv.get<CachedGitHubToken>(key);
    if (!entry.value) return null;
    // Return if more than 5 minutes remaining
    const remaining = entry.value.expires_at.getTime() - Date.now();
    if (remaining > 300_000) return entry.value.token;
    // Expired or close — delete and return null
    await this.#kv.delete(key);
    return null;
  }

  /** Cache a GitHub token for reuse. */
  async cacheToken(
    repo: string,
    scopes: string[],
    token: InstallationToken,
  ): Promise<void> {
    const key = [...GH_TOKEN_CACHE_PREFIX, repo, hashScopes(scopes)];
    await this.#kv.set(key, {
      token: token.token,
      expires_at: token.expiresAt,
    } satisfies CachedGitHubToken);
  }

  /** Remove a cached token (e.g., on 401 from GitHub). */
  async invalidateCache(repo: string, scopes: string[]): Promise<void> {
    const key = [...GH_TOKEN_CACHE_PREFIX, repo, hashScopes(scopes)];
    await this.#kv.delete(key);
  }

  // ─── High-level token request ────────────────────────────────────────────

  /**
   * Process an agent's token request.
   *
   * 1. Check consent → if no consent, return needs_consent with URL
   * 2. Check cache → if valid cached token, return it
   * 3. Create new GitHub installation token → cache + return
   */
  async requestToken(
    params: TokenRequestParams,
    userId?: number,
  ): Promise<TokenRequestResult> {
    const { repo, scopes } = params;
    const scopePreset = scopes.sort().join("+") as ScopePreset;
    const perms = permissionsFromScopes(scopes);

    // Step 1: Check consent (needs userId)
    if (userId !== undefined) {
      const consented = await this.checkConsent(userId, repo, scopes);
      if (!consented) {
        return {
          status: "needs_consent",
          url: this.buildConsentUrl(repo, scopes, `${userId}:${repo}:${hashScopes(scopes)}`),
        };
      }
    }

    // Step 2: Check cache
    const cached = await this.getCachedToken(repo, scopes);
    if (cached) {
      return { status: "ok", token: cached, expires_at: "cached" };
    }

    // Step 3: Create new token
    const token = await this.#githubApp.createInstallationToken(
      perms,
      [repo],
    );

    await this.cacheToken(repo, scopes, token);

    return {
      status: "ok",
      token: token.token,
      expires_at: token.expiresAt.toISOString(),
    };
  }

  /** Confirm consent and issue a token. */
  async confirmAndIssue(
    userId: number,
    repo: string,
    scopes: string[],
  ): Promise<TokenRequestResult> {
    await this.recordConsent(userId, repo, scopes);
    return await this.requestToken({ repo, scopes }, userId);
  }
}
