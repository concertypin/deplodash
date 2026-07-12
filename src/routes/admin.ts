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
import { GitHubClient } from "@/github";
import { validator, describeRoute, resolver } from "hono-openapi";
import * as z from "zod";

const errorResponseSchema = z.object({
    error: z
        .string()
        .meta({
            description: "Error message",
            examples: ["Not authenticated", "Forbidden"],
        }),
});

const agentListResponseSchema = z.object({
    status: z.literal("ok"),
    tokens: z.array(
        z.object({
            agent_id: z
                .string()
                .meta({
                    description: "Unique agent identifier",
                    examples: ["agent-42"],
                }),
            label: z
                .string()
                .meta({
                    description: "Human-readable agent label",
                    examples: ["CI/CD Pipeline"],
                }),
            created_at: z
                .number()
                .meta({
                    description:
                        "Unix timestamp (ms) when the token was created",
                }),
        })
    ),
});

const revokeAgentTokenSchema = z.object({
    token: z
        .string()
        .min(1)
        .meta({
            description: "Agent token to revoke",
            examples: ["agent-token-abc123"],
        }),
});

const revokeResponseSchema = z.object({
    status: z
        .literal("ok")
        .meta({ description: "Always 'ok' on successful revocation" }),
});

function isAdminUser(login: string, adminUsers: string | undefined): boolean {
    if (!adminUsers) return false;
    return adminUsers
        .split(",")
        .map((u) => u.trim().toLowerCase())
        .includes(login.toLowerCase());
}

export const adminRouter = new Hono<HonoEnv>();

// Apply sessionMiddleware to all admin routes
adminRouter.use("*", sessionMiddleware());

/**
 * GET /api/admin/agent/list
 * Returns all registered agent tokens (metadata only, no raw tokens).
 */
adminRouter.get(
    "/agent/list",
    describeRoute({
        tags: ["Admin"],
        description:
            "Returns all registered agent tokens (metadata only, no raw tokens).",
        responses: {
            200: {
                description: "Success",
                content: {
                    "application/json": {
                        schema: resolver(agentListResponseSchema),
                    },
                },
            },
            401: {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
            403: {
                description: "Forbidden",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
        },
    }),
    async (c) => {
        const ghToken = c.get("gh_token");
        if (!ghToken) {
            return c.json({ error: "Not authenticated" }, 401);
        }

        // Check admin authorization
        try {
            const ghClient = new GitHubClient(ghToken);
            const user = await ghClient.getUser();
            if (!isAdminUser(user.login, c.env.GITHUB_ADMIN_USERS)) {
                return c.json({ error: "Forbidden" }, 403);
            }
        } catch {
            return c.json({ error: "Failed to verify admin access" }, 403);
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
    }
);

/**
 * POST /api/admin/agent/revoke
 * Revoke an agent token.
 */
adminRouter.post(
    "/agent/revoke",
    describeRoute({
        tags: ["Admin"],
        description: "Revoke an agent token.",
        responses: {
            200: {
                description: "Success",
                content: {
                    "application/json": {
                        schema: resolver(revokeResponseSchema),
                    },
                },
            },
            400: {
                description: "Bad request",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
            401: {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
            403: {
                description: "Forbidden",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
        },
    }),
    async (c, next) => {
        try {
            await c.req.json();
        } catch {
            return c.json({ error: "Invalid JSON body" }, 400);
        }
        await next();
    },
    validator("json", revokeAgentTokenSchema, (result, c) => {
        if (!result.success) {
            return c.json({ error: "Missing or invalid 'token' field" }, 400);
        }
    }),
    async (c) => {
        const ghToken = c.get("gh_token");
        if (!ghToken) {
            return c.json({ error: "Not authenticated" }, 401);
        }

        // Check admin authorization
        try {
            const ghClient = new GitHubClient(ghToken);
            const user = await ghClient.getUser();
            if (!isAdminUser(user.login, c.env.GITHUB_ADMIN_USERS)) {
                return c.json({ error: "Forbidden" }, 403);
            }
        } catch {
            return c.json({ error: "Failed to verify admin access" }, 403);
        }

        const { token } = c.req.valid("json");
        await revokeAgentToken(c.env.KV, token);
        return c.json({ status: "ok" });
    }
);
