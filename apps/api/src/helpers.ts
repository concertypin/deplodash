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
