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
     * Full callback URL for OAuth (e.g. http://localhost:5178/callback).
     */
    CALLBACK_URL: string;
    /**
     * Encryption key for session/SSH-key cookies.
     */
    ENCRYPTION_SECRET: string;
    /**
     * Direct GitHub PAT — skips OAuth flow (optional, dev/testing only).
     */
    GITHUB_TOKEN?: string;
    /**
     * Cloudflare KV namespace for agent tokens, consent records, and token cache.
     */
    KV: KVNamespace;
    /**
     * GitHub App ID (required for v2 token service).
     */
    GITHUB_APP_ID?: string;
    /**
     * PEM-encoded RSA private key for the GitHub App (required for v2).
     */
    GITHUB_APP_PRIVATE_KEY?: string;
    /**
     * GitHub App Installation ID (required for v2).
     */
    GITHUB_INSTALLATION_ID?: string;
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
 * Scope presets for GitHub App Installation Tokens.
 */
export type ScopePreset =
    | "contents:read"
    | "contents:write"
    | "contents:write+workflows:write"
    | "admin";

/**
 * A consent record stored in KV.
 */
export type ConsentRecord = {
    granted_at: string;
};

/**
 * A cached GitHub Installation Token in KV.
 */
export type CachedToken = {
    token: string;
    expires_at: string;
};
