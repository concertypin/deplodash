import type { RepositoryMode } from "@/types";

// Re-export hashScopes for backward compatibility (tests import from @/helpers).
export { hashScopes } from "@/github/scopes";

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function parseRepo(s: string): { owner: string; repo: string } | null {
    const m = s.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
    return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function isSafeRedirect(url: string): boolean {
    return (
        url.startsWith("/") &&
        (url.length === 1 || (url[1] !== "/" && url[1] !== "\\"))
    );
}

/**
 * Normalize a repository identity for consent KV keys and waiter matching.
 * GitHub repository names are case-insensitive, so consent recorded as
 * "Owner/Repo" must be found by a later request for "owner/repo".
 */
export function normalizeRepo(repo: string): string {
    return repo.trim().toLowerCase();
}

/**
 * Build the consent page URL an agent forwards to the user, asking them to
 * approve `scopes` for `repo` under `agentId`.
 */
export function buildConsentUrl(
    baseUrl: string,
    params: {
        repo: string;
        agentId: string;
        scopes: string[];
        repoMode: RepositoryMode;
    }
): string {
    return (
        `${baseUrl}/auth/consent?repo=${encodeURIComponent(params.repo)}` +
        `&agent_id=${encodeURIComponent(params.agentId)}` +
        `&scopes=${encodeURIComponent(params.scopes.join(","))}` +
        `&repo_mode=${encodeURIComponent(params.repoMode)}`
    );
}
