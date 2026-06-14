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
    return (
        url.startsWith("/") &&
        (url.length === 1 || (url[1] !== "/" && url[1] !== "\\"))
    );
}

/**
 * Hash a scope array for use as a KV key.
 * Returns a 16-char base64url-encoded SHA-256 digest of the sorted, joined scopes.
 */
export async function hashScopes(scopes: string[]): Promise<string> {
    const sorted = [...scopes].sort().join(",");
    const utf8 = new TextEncoder().encode(sorted);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8));
    return btoa(String.fromCharCode(...hash))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
        .slice(0, 16);
}
