import { TokenExpiredError } from "@/errors";
import type { Repo, GitHubUser } from "@/types";
import * as z from "zod";

// ─── OAuth Token Types ───────────────────────────────────────────────────

export type OAuthTokenResult = {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    refreshTokenExpiresIn: number;
};

const accessTokenResponseSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.literal("bearer"),
    scope: z.string().transform((s) => s.split(",")),
    expires_in: z.number(),
    refresh_token: z.string(),
    refresh_token_expires_in: z.number(),
});

// ─── GitHub API Client ──────────────────────────────────────────────────────

export class GitHubClient {
    private readonly token: string;
    private readonly base = "https://api.github.com";

    constructor(token: string) {
        this.token = token;
    }

    private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
        const reqHeaders: Record<string, string> = {
            Authorization: `Bearer ${this.token}`,
            "User-Agent": "deplodash/1.0",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        };
        if (init.headers) {
            const h = init.headers;
            if (h instanceof Headers) {
                h.forEach((v, k) => {
                    reqHeaders[k] = v;
                });
            } else if (Array.isArray(h)) {
                for (const [k, v] of h) reqHeaders[k] = v;
            } else {
                Object.assign(reqHeaders, h);
            }
        }
        const res = await fetch(`${this.base}${path}`, {
            ...init,
            headers: reqHeaders,
        });

        if (res.status === 401) {
            throw new TokenExpiredError();
        }

        if (res.status === 204) return undefined as unknown as T;
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            const remaining = res.headers.get("X-RateLimit-Remaining");
            const reset = res.headers.get("X-RateLimit-Reset");
            let extra = "";
            if (remaining !== null) extra += ` | Remaining: ${remaining}`;
            if (reset !== null)
                extra += ` | Resets: ${new Date(Number(reset) * 1000).toLocaleTimeString()}`;
            throw new Error(
                `GitHub ${res.status} ${path}: ${body.slice(0, 500)}${extra}`
            );
        }
        return res.json();
    }

    async listAllRepos(): Promise<Repo[]> {
        const all: Repo[] = [];
        for (let page = 1; ; page++) {
            const batch = await this.req<Repo[]>(
                `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
            );
            all.push(...batch);
            if (batch.length < 100) break;
        }
        return all;
    }

    async getUser(): Promise<GitHubUser> {
        return this.req<GitHubUser>("/user");
    }

    async checkRepoAdmin(owner: string, repo: string): Promise<boolean> {
        try {
            const data = await this.req<{ permissions?: { admin: boolean } }>(
                `/repos/${owner}/${repo}`
            );
            return data.permissions?.admin ?? false;
        } catch (err) {
            if (err instanceof TokenExpiredError) throw err;
            return false;
        }
    }

    async checkOrgAdmin(org: string, username: string): Promise<boolean> {
        try {
            const data = await this.req<{ role: string; state: string }>(
                `/orgs/${org}/memberships/${username}`
            );
            return data.role === "admin" && data.state === "active";
        } catch (err) {
            if (err instanceof TokenExpiredError) throw err;
            return false;
        }
    }

    /**
     * Check whether a repository exists for the authenticated user.
     *
     * @param owner - Repository owner.
     * @param repo - Repository name.
     * @returns Whether GitHub returned a repository for the requested name.
     */
    async repoExists(owner: string, repo: string): Promise<boolean> {
        try {
            await this.req<Repo>(`/repos/${owner}/${repo}`);
            return true;
        } catch (err: unknown) {
            if (
                err instanceof Error &&
                err.message.startsWith(`GitHub 404 /repos/${owner}/${repo}`)
            ) {
                return false;
            }
            throw err;
        }
    }

    /**
     * Create a private repository during the authenticated consent flow.
     *
     * OAuth user tokens can create repositories for the logged-in user and
     * organizations where that user is allowed to create repositories.
     *
     * @param owner - Repository owner.
     * @param repo - Repository name.
     * @param isPrivate - Whether the new repository is private.
     * @param currentUser - Login of the authenticated OAuth user.
     * @returns The created repository.
     */
    createRepository(
        owner: string,
        repo: string,
        isPrivate: boolean,
        currentUser: string
    ): Promise<Repo> {
        const path =
            owner.toLowerCase() === currentUser.toLowerCase()
                ? "/user/repos"
                : `/orgs/${owner}/repos`;
        return this.req<Repo>(path, {
            method: "POST",
            body: JSON.stringify({
                name: repo,
                private: isPrivate,
                auto_init: true,
            }),
        });
    }

    async rateLimit(): Promise<{
        remaining: number;
        limit: number;
        reset: number;
    }> {
        return (
            await this.req<{
                rate: { remaining: number; limit: number; reset: number };
            }>("/rate_limit")
        ).rate;
    }

    async exchangeCode(
        code: string,
        verifier: string,
        clientId: string,
        clientSecret: string,
        redirectUri: string
    ): Promise<OAuthTokenResult> {
        const res = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                code_verifier: verifier,
                redirect_uri: redirectUri,
            }),
        }).then((r) => r.json());

        const { data, success } = accessTokenResponseSchema.safeParse(res);

        if (!success)
            throw new Error(
                `No access_token in OAuth response, received: ${JSON.stringify(res)}`
            );
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            refreshTokenExpiresIn: data.refresh_token_expires_in,
        } satisfies OAuthTokenResult;
    }

    /**
     * Refresh an expired user access token using a refresh token with rotation.
     * POST /login/oauth/access_token with grant_type=refresh_token.
     * Both the access_token and refresh_token are rotated (old becomes invalid).
     */
    async refreshAccessToken(
        refreshToken: string,
        clientId: string,
        clientSecret: string
    ): Promise<OAuthTokenResult> {
        const res = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "refresh_token",
                refresh_token: refreshToken,
            }),
        }).then((r) => r.json());

        const { data, success } = accessTokenResponseSchema.safeParse(res);
        if (!success)
            throw new Error(
                `No access_token in refresh response, received: ${JSON.stringify(res)}`
            );
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            refreshTokenExpiresIn: data.refresh_token_expires_in,
        } satisfies OAuthTokenResult;
    }
}
