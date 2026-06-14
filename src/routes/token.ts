/**
 * Agent token routes — Issue GitHub Installation Tokens to authenticated agents.
 *
 * Mounted at /api — paths are relative (/api/token).
 *
 * Flow:
 *   1. Agent POST /api/token with Bearer token + { repo, scopes }
 *   2. If consent exists → return token
 *   3. If no consent → return needs_consent with URL
 */

import { Hono } from "hono";
import { validator, describeRoute, resolver } from "hono-openapi";
import * as z from "zod";
import type { HonoEnv } from "@/types";
import { agentAuthMiddleware } from "@/middleware/agent-auth";
import { TokenService } from "@/token-service";
import { GitHubApp } from "@/github-app";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const requestTokenSchema = z.object({
    repo: z
        .string()
        .min(1)
        .regex(/^[\w.-]+\/[\w.-]+$/, "Invalid repo format (use owner/repo)"),
    scopes: z.array(z.string().min(1)).min(1).default(["contents:read"]),
});

const tokenResponseSchema = z.object({
    status: z.literal("ok"),
    token: z.string(),
    expires_at: z.string(),
});

const errorResponseSchema = z.object({
    error: z.string(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /api — relative paths

export const tokenRouter = new Hono<HonoEnv>();

// ── POST /api/token — Request a GitHub Installation Token ────────────

tokenRouter.post(
    "/token",
    agentAuthMiddleware(),
    describeRoute({
        description:
            "Request a scoped GitHub Installation Token for a repository",
        responses: {
            200: {
                description: "Token issued or needs consent",
                content: {
                    "application/json": {
                        schema: resolver(tokenResponseSchema),
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
                description: "Invalid or missing agent token",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
        },
    }),
    validator("json", requestTokenSchema),
    async (c) => {
        const { repo, scopes } = c.req.valid("json");
        const agentId = c.get("agent_id");
        if (!agentId) {
            return c.json({ error: "Agent not authenticated" }, 401);
        }

        // Check if GitHub App is configured
        const appId = c.env.GITHUB_APP_ID;
        const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
        const installationId = c.env.GITHUB_INSTALLATION_ID;
        if (!appId || !privateKey || !installationId) {
            return c.json(
                {
                    error: "GitHub App not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_INSTALLATION_ID.",
                },
                400
            );
        }

        try {
            const tokenService = new TokenService(c.env.KV);
            const githubApp = new GitHubApp(appId, installationId, privateKey);

            // Determine base URL for consent redirect
            const url = new URL(c.req.url);
            const baseUrl = `${url.protocol}//${url.host}`;

            const result = await tokenService.requestToken(
                { repo, scopes, baseUrl },
                () => githubApp.requestToken(scopes)
            );

            return c.json(result, 200);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ error: msg }, 500);
        }
    }
);
