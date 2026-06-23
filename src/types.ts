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
 * All supported scopes for GitHub App Installation Tokens.
 */
export type Scope =
    | "contents:read"
    | "contents:write"
    | "issues:read"
    | "issues:write"
    | "pulls:read"
    | "pulls:write"
    | "actions:read"
    | "actions:write"
    | "metadata:read"
    | "deployments:read"
    | "deployments:write"
    | "administration:read"
    | "administration:write"
    | "members:read"
    | "members:write"
    | "secrets:read"
    | "secrets:write"
    | "pages:read"
    | "pages:write"
    | "webhooks:read"
    | "webhooks:write"
    | "environments:read"
    | "environments:write"
    | "variables:read"
    | "variables:write"
    | "workflows:write"
    | "checks:read"
    | "checks:write";

/**
 * Human-readable labels for each scope.
 */
export const SCOPE_LABELS: Record<string, string> = {
    "contents:read": "Read repository contents",
    "contents:write": "Read & write repository contents",
    "issues:read": "Read issues",
    "issues:write": "Read & write issues",
    "pulls:read": "Read pull requests",
    "pulls:write": "Read & write pull requests",
    "actions:read": "View Actions workflows & runs",
    "actions:write": "Manage Actions workflows & runs",
    "metadata:read": "Read repository metadata",
    "deployments:read": "View deployments",
    "deployments:write": "Manage deployments",
    "administration:read": "View repository settings",
    "administration:write": "Manage repository settings (rename, delete)",
    "members:read": "View collaborators",
    "members:write": "Manage collaborators",
    "secrets:read": "View repository secrets & variables",
    "secrets:write": "Manage repository secrets & variables",
    "pages:read": "View GitHub Pages settings",
    "pages:write": "Manage GitHub Pages settings & builds",
    "webhooks:read": "View webhooks",
    "webhooks:write": "Manage webhooks",
    "environments:read": "View environments",
    "environments:write": "Manage environments",
    "variables:read": "View Actions variables",
    "variables:write": "Manage Actions variables",
    "workflows:write": "Manage workflow files",
    "checks:read": "View check runs & suites",
    "checks:write": "Create & update check runs",
};

/**
 * Scope categories for UI grouping.
 * Keyed by category ID.
 */
export const SCOPE_CATEGORIES: Record<
    string,
    { label: string; scopes: string[] }
> = {
    contents: {
        label: "📂 Repository Contents",
        scopes: ["contents:read", "contents:write", "workflows:write"],
    },
    issues: {
        label: "🔀 Issues",
        scopes: ["issues:read", "issues:write"],
    },
    pulls: {
        label: "🔁 Pull Requests",
        scopes: ["pulls:read", "pulls:write"],
    },
    actions: {
        label: "✅ Actions & CI",
        scopes: [
            "actions:read",
            "actions:write",
            "checks:read",
            "checks:write",
            "variables:read",
            "variables:write",
        ],
    },
    metadata: {
        label: "📋 Metadata",
        scopes: ["metadata:read", "deployments:read", "deployments:write"],
    },
    administration: {
        label: "🔐 Administration",
        scopes: ["administration:read", "administration:write"],
    },
    security: {
        label: "🛡️ Security & Access",
        scopes: [
            "secrets:read",
            "secrets:write",
            "members:read",
            "members:write",
        ],
    },
    pages: {
        label: "🌐 Pages & Webhooks",
        scopes: [
            "pages:read",
            "pages:write",
            "webhooks:read",
            "webhooks:write",
        ],
    },
    environments: {
        label: "🗂️ Environments",
        scopes: ["environments:read", "environments:write"],
    },
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
