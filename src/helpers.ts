// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function normalizeKey(key: string): string {
  return key.trim().split(/\s+/).slice(0, 2).join(" ");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function parseCookies(header: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    result[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return result;
}

export function cookieSet(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict" } = {}): string {
  let c = `${name}=${value}; Path=/`;
  if (opts.httpOnly ?? true) c += "; HttpOnly";
  if (opts.sameSite) c += `; SameSite=${opts.sameSite}`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${opts.maxAge}`;
  return c;
}

export function parseRepo(s: string): { owner: string; repo: string } | null {
  const m = s.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
