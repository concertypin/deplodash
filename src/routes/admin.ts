/**
 * Admin routes — Agent token management (list, revoke).
 *
 * Mounted at /api/admin — paths are relative (/api/admin/agent/list, /api/admin/agent/revoke).
 *
 * Requires a valid session cookie (set by OAuth login via /auth/github).
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { sessionMiddleware } from "@/middleware";
import { listAgentTokens, revokeAgentToken } from "@/middleware/agent-auth";

export const adminRouter = new Hono<HonoEnv>();

// Apply sessionMiddleware to all admin routes
adminRouter.use("*", sessionMiddleware());

/**
 * GET /api/admin/agent/list
 * Returns all registered agent tokens (metadata only, no raw tokens).
 */
adminRouter.get("/agent/list", async (c) => {
    const ghToken = c.get("gh_token");
    if (!ghToken) {
        return c.json({ error: "Not authenticated" }, 401);
    }

    const tokens = await listAgentTokens(c.env.KV);
    return c.json({
        status: "ok",
        tokens: tokens.map((t) => ({
            agent_id: t.info.agent_id,
            label: t.info.label,
            created_at: t.info.created_at,
        })),
    });
});

/**
 * POST /api/admin/agent/revoke
 * Revoke an agent token.
 * Body: { token: string }
 */
adminRouter.post("/agent/revoke", async (c) => {
    const ghToken = c.get("gh_token");
    if (!ghToken) {
        return c.json({ error: "Not authenticated" }, 401);
    }

    let body: { token?: string };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }

    const token = body?.token;
    if (!token || typeof token !== "string" || token.length === 0) {
        return c.json({ error: "Missing or invalid 'token' field" }, 400);
    }

    await revokeAgentToken(c.env.KV, token);
    return c.json({ status: "ok" });
});
