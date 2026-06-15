import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { renderHomePage } from "@/html";

// ─── Page Routes ─────────────────────────────────────────────────────────────
// Mounted at / — paths are /

export const pagesRouter = new Hono<HonoEnv>()

    // ── Home (root) ───────────────────────────────────────────────────────────

    .get("/", authGuard(), async (c) => {
        const client = c.get("client")!;
        try {
            // Fetch user info for the welcome page
            const user = await client.getUser();
            return c.html(
                renderHomePage({
                    login: user.login,
                    avatarUrl: user.avatar_url,
                })
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.html(
                `<div class="p-8 text-error">Error: ${escapeHtml(msg)}</div>`
            );
        }
    });

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
