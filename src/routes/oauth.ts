import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { HonoEnv } from "@/types";
import { GitHubClient } from "@/github";
import { getOrInitKey, encryptWith, decryptWith } from "@/crypto";
import { isSafeRedirect } from "@/helpers";
import { TokenExpiredError } from "@/errors";
import { COOKIE_NAME, MAX_AGE_SECS } from "@/middleware";
import { z } from "zod";

const statePayloadSchema = z.object({
    v: z.string(),
    n: z.string().optional(),
    r: z.string().optional(),
});

// ─── OAuth callback & logout routes (mounted at root level) ──────────────────
// These are intentionally NOT under /auth to match the legacy app.

export const oauthRouter = new Hono<HonoEnv>()
    .get("/callback", async (c) => {
        const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
        const code = c.req.query("code");
        const state = c.req.query("state");
        if (!code || !state) return c.text("Missing code or state", 400);

        const plain = await decryptWith(key, state);
        if (!plain) return c.text("Invalid state", 400);
        let parsed: unknown;
        try {
            parsed = JSON.parse(plain);
        } catch {
            return c.text("Invalid state payload", 400);
        }
        const result = statePayloadSchema.safeParse(parsed);
        if (!result.success) return c.text("Invalid state payload", 400);
        const payload = result.data;

        const redirectUri = payload.r || c.env.CALLBACK_URL;

        const tempClient = new GitHubClient("");
        try {
            const accessToken = await tempClient.exchangeCode(
                code,
                payload.v,
                c.env.GITHUB_CLIENT_ID,
                c.env.GITHUB_CLIENT_SECRET,
                redirectUri
            );
            const encryptedToken = await encryptWith(key, accessToken);
            const next = isSafeRedirect(payload.n || "/")
                ? (payload.n ?? "/")
                : "/";
            const isHttps = c.req.url.startsWith("https://");
            setCookie(c, COOKIE_NAME, encryptedToken, {
                path: "/",
                httpOnly: true,
                sameSite: "Lax",
                secure: isHttps,
                maxAge: MAX_AGE_SECS,
            });
            return c.redirect(next);
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/auth/github");
            }
            const msg = err instanceof Error ? err.message : String(err);
            return c.text(`OAuth failed: ${msg}`, 400);
        }
    })
    .get("/logout", (c) => {
        setCookie(c, COOKIE_NAME, "", {
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            maxAge: 0,
        });
        return c.redirect("/");
    });
