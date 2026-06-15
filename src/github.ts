import { TokenExpiredError } from "@/errors";
import type { Repo, DeployKey } from "@/types";
import * as z from "zod";
const accessTokenResponseSchema = z.object({
    access_token: z.string(),
    token_type: z.literal("bearer"),
    scope: z.string().transform((s) => s.split(",")),
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

    async listDeployKeys(owner: string, repo: string): Promise<DeployKey[]> {
        const all: DeployKey[] = [];
        for (let page = 1; ; page++) {
            const batch = await this.req<DeployKey[]>(
                `/repos/${owner}/${repo}/keys?per_page=100&page=${page}`
            );
            all.push(...batch);
            if (batch.length < 100) break;
        }
        return all;
    }

    addDeployKey(
        owner: string,
        repo: string,
        title: string,
        key: string,
        writable: boolean
    ): Promise<DeployKey> {
        return this.req<DeployKey>(`/repos/${owner}/${repo}/keys`, {
            method: "POST",
            body: JSON.stringify({ title, key, read_only: !writable }),
        });
    }

    removeDeployKey(owner: string, repo: string, keyId: number): Promise<void> {
        return this.req<void>(`/repos/${owner}/${repo}/keys/${keyId}`, {
            method: "DELETE",
        });
    }

    createRepo(name: string, isPrivate: boolean): Promise<Repo> {
        return this.req<Repo>("/user/repos", {
            method: "POST",
            body: JSON.stringify({
                name,
                private: isPrivate,
                auto_init: false,
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
    ): Promise<string> {
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
        });

        const data = accessTokenResponseSchema.parse(await res.json());
        if (!data.access_token)
            throw new Error("No access_token in OAuth response");
        return data.access_token;
    }
}
