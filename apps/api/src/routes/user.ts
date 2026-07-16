import {
    listAgentTokens,
    registerAgentToken,
    revokeAgentToken,
    verifyAgentToken,
} from "@/middleware/agent-auth";
import { randomBytes } from "@/crypto";
import { validator } from "hono-openapi";
import { z } from "zod";

const createAgentSchema = z.object({
    agent_id: z
        .string()
        .min(1, "Agent ID is required")
        .max(64, "Agent ID too long"),
    label: z.string().max(128, "Label too long").optional(),
});

const revokeAgentSchema = z.object({
    token: z.string().min(1, "Token is required"),
});

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
    })

    // Agent token management routes
    .get("/agent/list", sessionMiddleware(), authGuard(), async (c) => {
        const client = c.get("client")!;
        const user = await client.getUser();

        const allTokens = await listAgentTokens(c.env.KV);
        const userTokens = allTokens.filter(
            (t) => t.info.created_by === user.login
        );

        return c.json({
            status: "ok",
            tokens: userTokens.map((t) => ({
                token: t.token,
                agent_id: t.info.agent_id,
                label: t.info.label,
                created_at: t.info.created_at,
            })),
        });
    })

    .post(
        "/agent/create",
        sessionMiddleware(),
        authGuard(),
        validator("json", createAgentSchema),
        async (c) => {
            const client = c.get("client")!;
            const user = await client.getUser();
            const { agent_id, label } = c.req.valid("json");

            const token = randomBytes(24);
            await registerAgentToken(
                c.env.KV,
                token,
                agent_id,
                label,
                user.login
            );

            return c.json({
                status: "ok",
                token,
                info: {
                    agent_id,
                    label: label ?? agent_id,
                    created_at: new Date().toISOString(),
                    created_by: user.login,
                },
            });
        }
    )

    .post(
        "/agent/revoke",
        sessionMiddleware(),
        authGuard(),
        validator("json", revokeAgentSchema),
        async (c) => {
            const client = c.get("client")!;
            const user = await client.getUser();
            const { token } = c.req.valid("json");

            const info = await verifyAgentToken(c.env.KV, token);
            if (!info || info.created_by !== user.login) {
                return c.json({ error: "Forbidden or token not found" }, 403);
            }

            await revokeAgentToken(c.env.KV, token);
            return c.json({ status: "ok" });
        }
    );
