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
};

// ─── Hono Environment Type ───────────────────────────────────────────────────

export type AppVariables = {
    gh_token?: string | null;
    ssh_key?: string | null;
    client?: GitHubClient;
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

export type DeployKey = {
    readonly id: number;
    readonly key: string;
    readonly title: string;
    readonly read_only: boolean;
    readonly verified: boolean;
};

export type RepoStatus = {
    repo: Repo;
    keyId: number | null;
    hasAdmin: boolean;
};

export type AppState = {
    sshKey: string;
    sshKeyTitle: string;
    normalizedKey: string;
    repos: RepoStatus[];
    loadedAt: Date;
    readOnly: boolean;
};
