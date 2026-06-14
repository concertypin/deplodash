// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function normalizeKey(key: string): string {
    return key.trim().split(/\s+/).slice(0, 2).join(" ");
}

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

export function parsePerm(s: string): boolean {
    return s !== "RO";
}

export function isSafeRedirect(url: string): boolean {
    return url.startsWith("/") && !url.startsWith("//");
}
