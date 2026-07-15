import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { HonoEnv, SessionPayload } from "@/types";
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
        // Rate limiting — per-IP throttle for OAuth callback
        const rateLimiter = c.env.TOKEN_RATE_LIMITER;
        if (rateLimiter) {
            try {
                const { success } = await rateLimiter.limit({
                    key: c.req.header("CF-Connecting-IP") || "unknown",
                });
                if (!success) {
                    return c.text("Rate limited. Try again later.", 429);
                }
            } catch {
                // Rate limiter unavailable (e.g., local dev) — proceed
            }
        }
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
            const oauthResult = await tempClient.exchangeCode(
                code,
                payload.v,
                c.env.GITHUB_CLIENT_ID,
                c.env.GITHUB_CLIENT_SECRET,
                redirectUri
            );
            const sessionPayload: SessionPayload = {
                accessToken: oauthResult.accessToken,
                refreshToken: oauthResult.refreshToken,
                accessExpiresAt: Date.now() + oauthResult.expiresIn * 1000,
                refreshExpiresAt:
                    Date.now() + oauthResult.refreshTokenExpiresIn * 1000,
            };
            const encryptedSession = await encryptWith(
                key,
                JSON.stringify(sessionPayload)
            );
            const next = isSafeRedirect(payload.n || "/")
                ? (payload.n ?? "/")
                : "/";
            setCookie(c, COOKIE_NAME, encryptedSession, {
                path: "/",
                httpOnly: true,
                sameSite: "Strict",
                secure: true,
                maxAge: MAX_AGE_SECS,
            });
            return c.redirect(next);
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/auth/github");
            }
            const msg = err instanceof Error ? err.message : String(err);
            const encryptedMessage = await encryptWith(key, msg);
            return c.text(
                `OAuth failed. Debug token: ${encryptedMessage}`,
                400
            );
        }
    })
    .get("/logout", (c) => {
        setCookie(c, COOKIE_NAME, "", {
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
            maxAge: 0,
        });
        return c.redirect("/");
    });
