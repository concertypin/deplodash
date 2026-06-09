import { TokenExpiredError } from "./errors.ts";
import type { Repo, DeployKey } from "./types.ts";

// ─── GitHub API Client ──────────────────────────────────────────────────────

export class GitHubClient {
  readonly #token: string;
  readonly #base = "https://api.github.com";

  constructor(token: string) { this.#token = token; }

  async #req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers,
      },
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
      if (reset !== null) extra += ` | Resets: ${new Date(Number(reset) * 1000).toLocaleTimeString()}`;
      throw new Error(`GitHub ${res.status} ${path}: ${body.slice(0, 500)}${extra}`);
    }
    return res.json() as Promise<T>;
  }

  async listAllRepos(): Promise<Repo[]> {
    const all: Repo[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.#req<Repo[]>(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  listDeployKeys(owner: string, repo: string): Promise<DeployKey[]> {
    return this.#req<DeployKey[]>(`/repos/${owner}/${repo}/keys?per_page=100`);
  }

  addDeployKey(owner: string, repo: string, title: string, key: string, readOnly: boolean): Promise<DeployKey> {
    return this.#req<DeployKey>(`/repos/${owner}/${repo}/keys`, {
      method: "POST",
      body: JSON.stringify({ title, key, read_only: readOnly }),
    });
  }

  removeDeployKey(owner: string, repo: string, keyId: number): Promise<void> {
    return this.#req<void>(`/repos/${owner}/${repo}/keys/${keyId}`, { method: "DELETE" });
  }

  createRepo(name: string, isPrivate: boolean): Promise<Repo> {
    return this.#req<Repo>("/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
    });
  }

  async rateLimit(): Promise<{ remaining: number; limit: number; reset: number }> {
    return (await this.#req<{ rate: { remaining: number; limit: number; reset: number } }>("/rate_limit")).rate;
  }

  async exchangeCode(code: string, verifier: string, clientId: string, clientSecret: string, redirectUri: string): Promise<string> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`OAuth error: ${data.error_description ?? data.error}`);
    if (!data.access_token) throw new Error("No access_token in OAuth response");
    return data.access_token as string;
  }
}
