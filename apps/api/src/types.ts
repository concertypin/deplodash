import type { GitHubClient } from "@/github";

// ─── Environment Variables (Cloudflare Workers Bindings) ─────────────────────

export type Env = {
    /**
     * GitHub OAuth App client ID.
     */
    GITHUB_CLIENT_ID: string;
    /**
     * GitHub OAuth App client secret.
     */
    GITHUB_CLIENT_SECRET: string;
    /**
     * Full callback URL for OAuth.
     */
    CALLBACK_URL: string;
    /**
     * Encryption key for session cookies.
     */
    ENCRYPTION_SECRET: string;
    /**
     * Direct GitHub PAT — skips OAuth flow (optional, dev/testing only).
     */
    GITHUB_TOKEN?: string;
    /**
     * Comma-separated list of GitHub usernames allowed to access admin endpoints.
     * If not set or empty, admin endpoints return 403.
     */
    GITHUB_ADMIN_USERS?: string;
    /**
     * Cloudflare KV namespace for agent tokens, consent records, and token cache.
     */
    KV: KVNamespace;
    /**
     * GitHub App ID (required for token issuance).
     */
    GITHUB_APP_ID: string;
    /**
     * PEM-encoded RSA private key for the GitHub App (required for token issuance).
     */
    GITHUB_APP_PRIVATE_KEY: string;
    /**
     * Cloudflare Rate Limiting binding for /api/token endpoint.
     * Optional — rate limiting is a best-effort guard and gracefully skipped
     * when the binding is not available (e.g., local dev, test environments).
     */
    TOKEN_RATE_LIMITER?: RateLimit;
};

// ─── Hono Environment Type ───────────────────────────────────────────────────

export type AppVariables = {
    gh_token?: string | null;
    client?: GitHubClient;
    /** Agent ID extracted from bearer token (v2). */
    agent_id?: string;
};

export type HonoEnv = {
    Bindings: Env;
    Variables: AppVariables;
};

// ─── GitHub API Types ────────────────────────────────────────────────────────

export type Repo = {
    readonly full_name: string;
    readonly name: string;
    readonly owner: { readonly login: string };
    readonly private: boolean;
    readonly permissions?: {
        readonly admin: boolean;
        readonly push: boolean;
        readonly pull: boolean;
    };
    readonly html_url: string;
    readonly description: string | null;
};

// ─── v2 — GitHub App Token Service Types ─────────────────────────────────────

/**
 * GitHub user info returned by GET /user.
 */
export type GitHubUser = {
    id: number;
    login: string;
    avatar_url: string;
    name: string | null;
};

/**
 * An agent token record stored in KV.
 */
export type AgentInfo = {
    agent_id: string;
    label: string;
    created_at: string;
};

/**
 * A consent record stored in KV.
 * Stored under key `consent:${repo}:${scopesHash}`.
 */
export type ConsentRecord = {
    /** Repository full name (owner/repo). */
    repo: string;
    /** Comma-separated scope list as stored (approved scopes). */
    scopes: string;
    /** ISO 8601 timestamp of when consent was granted. */
    granted_at: string;
    /** Optional: the agent_id that requested the consent. */
    agent_id?: string;
    /** Optional: the originally requested scopes (before granular filtering). */
    requested_scopes?: string;
    /** GitHub user login who granted this consent. */
    granted_by?: string;
};

/**
 * A consent record with its KV key info, for dashboard display.
 */
export type ConsentEntry = {
    repo: string;
    scopes: string;
    granted_at: string;
    /** Originally requested scopes, if available (for showing granular diff on dashboard). */
    requested_scopes?: string;
    /** GitHub user login who granted this consent. */
    granted_by?: string;
    /** Agent ID that this consent was recorded for. */
    agent_id?: string;
};

/**
 * A cached GitHub Installation Token in KV.
 */

/**
 * Session payload stored in the encrypted session cookie.
 * access_token (8h expiry) + refresh_token (~6mo, rotated on each refresh).
 */
export type SessionPayload = {
    /** GitHub OAuth user access token. */
    accessToken: string;
    /** GitHub OAuth refresh token (for token rotation). */
    refreshToken: string;
    /** Access token expiry as epoch milliseconds. */
    accessExpiresAt: number;
    /** Refresh token expiry as epoch milliseconds. */
    refreshExpiresAt: number;
};

export type CachedToken = {
    token: string;
    expires_at: string;
};
