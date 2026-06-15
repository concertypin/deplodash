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
        const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
        const verifier = randomBytes(32);
        const challenge = await pkceChallenge(verifier);

        const next = c.req.valid("query").next;
        const statePayload = JSON.stringify({ v: verifier, n: next });
        const encryptedState = await encryptWith(key, statePayload);

        const redirectUri = c.req.query("redirect_uri") || c.env.CALLBACK_URL;
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
