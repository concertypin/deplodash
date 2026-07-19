/**
 * GitHub App — JWT signing + Installation Token issuance.
 *
 * Environment variables (via Env bindings):
 *   GITHUB_APP_ID            GitHub App ID (required)
 *   GITHUB_APP_PRIVATE_KEY   PEM-encoded RSA private key (required)
 *
 * Installation ID is resolved dynamically via the GitHub API:
 *   - GET /users/{owner}/installation   (for user accounts)
 *   - GET /orgs/{owner}/installation    (for organizations)
 */

import { z } from "zod";
import { pemToCryptoKey } from "@/github/pem-utils";
import { signJwt } from "@/github/jwt";
import { permissionsFromScopes } from "@/github/scopes";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Schema for the GitHub App Installation Token API response.
 */
const installationTokenResponseSchema = z.object({
    token: z.string(),
    expires_at: z.string(),
    permissions: z.record(z.string(), z.string()),
    repository_selection: z.string(),
});

/**
 * Schema for the GitHub App Installation lookup response.
 */
const installationSchema = z.object({
    id: z.number(),
    account: z.object({ login: z.string() }),
});

export interface InstallationToken {
    token: string;
    expires_at: string; // ISO 8601
    permissions: Record<string, string>;
    repositorySelection: string;
}

// ─── GitHub App Service ──────────────────────────────────────────────────────

export class GitHubApp {
    private appId: string;
    private privateKeyPem: string;
    private keyPromise: Promise<CryptoKey> | null = null;
    /** Cached installation ID per owner (in-memory, per-request). */
    private installationCache: Map<string, string> = new Map();
    /** KV namespace for cross-isolate caching of installation IDs and repo existence. */
    private readonly kv: KVNamespace | undefined;

    constructor(appId: string, privateKeyPem: string, kv?: KVNamespace) {
        this.appId = appId;
        this.privateKeyPem = privateKeyPem;
        this.kv = kv;
    }

    /**
     * Lazily parse the PEM key and return the CryptoKey.
     * The actual parsing is deferred until first use, so that creating a
     * GitHubApp instance does not eagerly reject on invalid keys.
     */
    private async getKey(): Promise<CryptoKey> {
        if (!this.keyPromise) {
            this.keyPromise = pemToCryptoKey(this.privateKeyPem);
        }
        return this.keyPromise;
    }

    /**
     * Sign a fresh JWT (10 min expiry).
     */
    private async getJwt(): Promise<string> {
        const key = await this.getKey();
        return signJwt(key, this.appId);
    }

    /**
     * Resolve the installation ID for a given repository owner (user or org).
     *
     * Calls the GitHub API to find the installation:
     *   - GET /users/{owner}/installation  (for user accounts)
     *   - GET /orgs/{owner}/installation   (for organizations)
     *
     * Falls back from org to user lookup automatically.
     */
    async resolveInstallationId(owner: string): Promise<string> {
        const cached = this.installationCache.get(owner);
        if (cached) return cached;

        // Check KV cache before hitting GitHub API
        const cacheKey = `installation_id::${owner}`;
        if (this.kv) {
            try {
                const kvCached = await this.kv.get(cacheKey);
                if (kvCached) {
                    this.installationCache.set(owner, kvCached);
                    return kvCached;
                }
            } catch {
                // KV unavailable — proceed with GitHub API
            }
        }

        const jwt = await this.getJwt();
        const headers = {
            Authorization: `Bearer ${jwt}`,
            "User-Agent": "deplodash/1.0",
            Accept: "application/vnd.github+json",
        };

        let installationId: string | null = null;

        // Try org installation first, then user
        const orgUrl = `https://api.github.com/orgs/${owner}/installation`;
        const orgRes = await fetch(orgUrl, { headers });

        if (orgRes.status === 200) {
            const data = installationSchema.parse(await orgRes.json());
            installationId = String(data.id);
        } else if (orgRes.status === 404) {
            const userUrl = `https://api.github.com/users/${owner}/installation`;
            const userRes = await fetch(userUrl, { headers });

            if (userRes.status === 200) {
                const data = installationSchema.parse(await userRes.json());
                installationId = String(data.id);
            } else if (userRes.status === 404) {
                throw new Error(
                    `GitHub App is not installed for "${owner}". ` +
                        "Please install the app first: " +
                        `https://github.com/apps/${this.appId}/installations/new`
                );
            } else {
                throw new Error(
                    `Failed to check user installation for "${owner}": ${userRes.status}`
                );
            }
        } else {
            throw new Error(
                `Failed to check org installation for "${owner}": ${orgRes.status}`
            );
        }

        if (!installationId) {
            throw new Error(
                `Could not resolve installation ID for "${owner}".`
            );
        }

        this.installationCache.set(owner, installationId);
        // Cache in KV for cross-isolate reuse (30 day TTL)
        if (this.kv) {
            try {
                await this.kv.put(cacheKey, installationId, {
                    expirationTtl: 86400 * 7,
                });
            } catch {
                // KV write failure is non-fatal
            }
        }
        return installationId;
    }

    /**
     * Exchange the App JWT for an Installation Token scoped to the given
     * permissions, using the provided installation ID.
     */
    async getInstallationToken(
        permissions: Record<string, string>,
        installationId?: string,
        repositories?: string[]
    ): Promise<InstallationToken> {
        const installId = installationId;
        if (!installId) {
            throw new Error(
                "No installation ID available. Call resolveInstallationId first."
            );
        }

        const jwt = await this.getJwt();
        const url = `https://api.github.com/app/installations/${installId}/access_tokens`;
        const body: Record<string, unknown> = { permissions };
        if (repositories !== undefined) {
            body.repositories = repositories;
        }
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${jwt}`,
                "User-Agent": "deplodash/1.0",
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`GitHub App token request failed: ${res.status}`);
        }
        const ghResponse = installationTokenResponseSchema.parse(
            await res.json()
        );
        return {
            token: ghResponse.token,
            expires_at: ghResponse.expires_at,
            permissions: ghResponse.permissions,
            repositorySelection: ghResponse.repository_selection,
        };
    }
    async requestToken(
        scopes: string[],
        owner: string,
        repoName?: string
    ): Promise<InstallationToken> {
        const perms = permissionsFromScopes(scopes);
        const installationId = await this.resolveInstallationId(owner);
        return this.getInstallationToken(
            perms,
            installationId,
            repoName ? [repoName] : undefined
        );
    }
    /**
     * Ensure a repository exists. If it doesn't, create it using the
     * GitHub App installation's admin permissions (only when allowCreate is true).
     */
    async ensureRepoExists(
        owner: string,
        repo: string,
        allowCreate = false
    ): Promise<boolean> {
        // Check KV cache first
        const cacheKey = `repo_exists::${owner}/${repo}`;
        if (this.kv) {
            try {
                const exists = await this.kv.get(cacheKey);
                if (exists === "1") return true;
            } catch {
                // KV unavailable — proceed with GitHub API
            }
        }

        const installationId = await this.resolveInstallationId(owner);
        const adminToken = await this.getInstallationToken(
            { administration: "write" },
            installationId
        );

        const checkRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
            {
                headers: {
                    Authorization: `Bearer ${adminToken.token}`,
                    "User-Agent": "deplodash/1.0",
                },
            }
        );
        if (checkRes.status === 200) {
            // Cache existence in KV (7 day TTL)
            if (this.kv) {
                try {
                    await this.kv.put(cacheKey, "1", {
                        expirationTtl: 86400 * 7,
                    });
                } catch {
                    // KV write failure is non-fatal
                }
            }
            return true;
        }
        if (checkRes.status !== 404) {
            throw new Error(
                `Failed to check repo existence: ${checkRes.status}`
            );
        }

        // Repo not found — either create or reject based on allowCreate
        if (!allowCreate) {
            throw new Error(
                "Failed to check repo existence: Repository not found."
            );
        }

        const orgRes = await fetch(`https://api.github.com/orgs/${owner}`, {
            headers: {
                Authorization: `Bearer ${adminToken.token}`,
                "User-Agent": "deplodash/1.0",
            },
        });
        const isOrg = orgRes.status === 200;

        const createUrl = isOrg
            ? `https://api.github.com/orgs/${owner}/repos`
            : `https://api.github.com/user/repos`;

        const createRes = await fetch(createUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${adminToken.token}`,
                "User-Agent": "deplodash/1.0",
                "Content-Type": "application/json",
                Accept: "application/vnd.github+json",
            },
            body: JSON.stringify({
                name: repo,
                private: true,
                auto_init: true,
            }),
        });

        if (!createRes.ok) {
            throw new Error(
                `Failed to create repo ${owner}/${repo}: ${createRes.status}`
            );
        }

        // Cache newly created repo (7 day TTL)
        if (this.kv) {
            try {
                await this.kv.put(cacheKey, "1", { expirationTtl: 86400 * 7 });
            } catch {
                // KV write failure is non-fatal
            }
        }
        return true;
    }
}
