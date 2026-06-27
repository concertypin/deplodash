import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token/service";
import { TokenExpiredError } from "@/errors";
import { renderPage, HomePage } from "@/views";
import type { ConsentItem } from "@/views";
import { escapeHtml } from "@/helpers";

// ─── Page Routes ─────────────────────────────────────────────────────────────
// Mounted at / — paths are /

export const pagesRouter = new Hono<HonoEnv>()

    // ── Home (root) ───────────────────────────────────────────────────────────

    .get("/", authGuard(), async (c) => {
        const client = c.get("client")!;
        try {
            // Fetch user info for the welcome page
            const user = await client.getUser();

            // Fetch consent list for the dashboard — only this user's consents
            const tokenService = new TokenService(c.env.KV);
            const consents: ConsentItem[] = await tokenService.listConsents(
                user.login
            );

            return c.html(
                renderPage(
                    <HomePage
                        login={user.login}
                        avatarUrl={user.avatar_url}
                        consents={consents}
                    />
                )
            );
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/auth/github");
            }
            const msg = err instanceof Error ? err.message : String(err);
            return c.html(
                `<div class="p-8 text-error">Error: ${escapeHtml(msg)}</div>`
            );
        }
    });
