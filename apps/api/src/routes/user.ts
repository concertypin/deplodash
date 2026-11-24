import {
    deleteAgentUidIndex,
    isAgentOwner,
    listAgentTokens,
    registerAgentToken,
    revokeAgentToken,
    verifyAgentToken,
} from "@/middleware/agent-auth";
import { OidcConsentService } from "@/oidc/consent";
import { agentSubject } from "@/oidc/token";
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
 * GET /api/user/oidc-consents — OIDC audiences approved for the user's agents
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

    // GET /api/user/oidc-consents — OIDC audiences approved for the user's agents
    .get("/oidc-consents", sessionMiddleware(), authGuard(), async (c) => {
        const client = c.get("client")!;
        const user = await client.getUser();
        const consents = new OidcConsentService(c.env.KV);
        const agents = (await listAgentTokens(c.env.KV)).filter(
            (t) => isAgentOwner(t.info, user) && t.info.uid
        );
        const items = [];
        for (const agent of agents) {
            for (const record of await consents.listForAgent(agent.info.uid!)) {
                items.push({
                    agent_id: record.agent_id,
                    agent_uid: record.agent_uid,
                    audience: record.audience,
                    provider: record.provider,
                    granted_by: record.granted_by,
                    granted_at: record.granted_at,
                });
            }
        }
        return c.json({ consents: items });
    })

    // Agent token management routes
    .get("/agent/list", sessionMiddleware(), authGuard(), async (c) => {
        const client = c.get("client")!;
        const user = await client.getUser();

        const allTokens = await listAgentTokens(c.env.KV);
        const userTokens = allTokens.filter((t) => isAgentOwner(t.info, user));

        // Agents created before OIDC support have no uid and never get one
        // at runtime (see isOidcOwner), so they have no OIDC subject.
        const tokens = userTokens.map((t) => ({
            token: t.token,
            agent_id: t.info.agent_id,
            label: t.info.label,
            created_at: t.info.created_at,
            ...(t.info.uid ? { oidc_subject: agentSubject(t.info.uid) } : {}),
        }));

        return c.json({ status: "ok", tokens });
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

            const allTokens = await listAgentTokens(c.env.KV);
            const duplicate = allTokens.some(
                (t) => t.info.agent_id === agent_id
            );
            if (duplicate) {
                return c.json({ error: "Agent ID already exists" }, 409);
            }

            const token = randomBytes(24);
            const info = await registerAgentToken(
                c.env.KV,
                token,
                agent_id,
                label,
                user.login,
                user.id
            );

            return c.json({
                status: "ok",
                token,
                info: {
                    agent_id: info.agent_id,
                    label: info.label,
                    created_at: info.created_at,
                    created_by: user.login,
                    oidc_subject: agentSubject(info.uid!),
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
            if (!info || !isAgentOwner(info, user)) {
                return c.json({ error: "Forbidden or token not found" }, 403);
            }

            await revokeAgentToken(c.env.KV, token);
            // The uid died with the token, so these can no longer be used;
            // delete them so they do not linger in KV.
            if (info.uid) {
                await new OidcConsentService(c.env.KV).revokeAll(info.uid);
                await deleteAgentUidIndex(c.env.KV, info.uid);
            }
            return c.json({ status: "ok" });
        }
    );
