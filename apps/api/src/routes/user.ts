/**
 * User token API — returns the authenticated GitHub user's OAuth token,
 * user profile, and consent list.
 *
 * GET /api/user/token   — user's personal OAuth access token
 * GET /api/user/me      — current GitHub user profile
 * GET /api/user/consents — user's granted consent list
 *
 * All endpoints require a valid session cookie (set by OAuth login via /auth/github).
 * Returns 401 if not authenticated.
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { sessionMiddleware, authGuard } from "@/middleware";
import { TokenService } from "@/token/service";

export const userRouter = new Hono<HonoEnv>()

    // GET /api/user/token — returns user's OAuth access token
    .get("/token", sessionMiddleware(), (c) => {
        const token = c.get("gh_token");

        if (!token) {
            return c.json({ error: "Not authenticated" }, 401);
        }

        return c.json({
            status: "ok",
            token,
        });
    })

    // GET /api/user/me — returns current GitHub user profile
    .get("/me", sessionMiddleware(), authGuard(), async (c) => {
        const client = c.get("client")!;
        const user = await client.getUser();

        return c.json({
            login: user.login,
            avatarUrl: user.avatar_url,
            name: user.name,
        });
    })

    // GET /api/user/consents — returns user's granted consents
    .get("/consents", sessionMiddleware(), authGuard(), async (c) => {
        const client = c.get("client")!;
        const user = await client.getUser();
        const tokenService = new TokenService(c.env.KV);
        const consents = await tokenService.listConsents(user.login);

        return c.json({ consents });
    });
