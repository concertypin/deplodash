import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { getOrInitKey } from "@/crypto";
import { randomBytes, pkceChallenge, encryptWith } from "@/crypto";
import { isSafeRedirect } from "@/helpers";
import { validator } from "hono-openapi";
import * as z from "zod";
// ─── Auth routes (mounted at /auth) ───────────────────────────────────────────
// Paths are relative to the mount point (/auth/github).

export const authRouter = new Hono<HonoEnv>().get(
    "/github",
    validator(
        "query",
        z.object({
            next: z
                .string()
                .default("/")
                .refine(isSafeRedirect, "Invalid redirect URL")
                .meta({
                    description: "URL to redirect to after login (default: /)",
                }),
        })
    ),
    async (c) => {
        // Rate limiting — per-IP throttle for auth endpoints
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
        const verifier = randomBytes(32);
        const challenge = await pkceChallenge(verifier);

        const next = c.req.valid("query").next;

        // Detect local dev — reflect the request origin as redirect_uri.
        // c.req.url is the actual URL the request reached, so it can't be spoofed.
        // Production always uses CALLBACK_URL from env to prevent open redirect attacks.
        const reqUrl = new URL(c.req.url);
        const isLocal =
            reqUrl.hostname === "localhost" || reqUrl.hostname === "127.0.0.1";
        const redirectUri = isLocal
            ? `${reqUrl.origin}/callback`
            : c.env.CALLBACK_URL;

        const statePayload = JSON.stringify({
            v: verifier,
            n: next,
            r: redirectUri,
        });
        const encryptedState = await encryptWith(
            key,
            statePayload,
            "oauth-state"
        );
        const params = new URLSearchParams({
            client_id: c.env.GITHUB_CLIENT_ID,
            redirect_uri: redirectUri,
            state: encryptedState,
            code_challenge: challenge,
            code_challenge_method: "S256",
            scope: "repo",
        });
        return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
    }
);
