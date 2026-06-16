/**
 * Agent token routes — Issue GitHub Installation Tokens to authenticated agents.
 *
 * Mounted at /api — paths are relative (/api/token).
 *
 * Flow:
 *   1. Agent POST /api/token with Bearer token + { repo, scopes }
 *   2. If repo doesn't exist → auto-create it (requires admin permission)
 *   3. If consent exists → return token (200)
 *   4. If no consent → return needs_consent with URL (202)
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

const needsConsentResponseSchema = z.object({
    status: z.literal("needs_consent"),
    url: z.string(),
});

const errorResponseSchema = z.object({
    error: z.string(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /api — relative paths

export const tokenRouter = new Hono<HonoEnv>().post(
    "/token",
    agentAuthMiddleware(),
    describeRoute({
        description:
            "Request a scoped GitHub Installation Token for a repository",
        responses: {
            200: {
                description: "Token issued",
                content: {
                    "application/json": {
                        schema: resolver(tokenResponseSchema),
                    },
                },
            },
            202: {
                description:
                    "Consent required — user must approve via the returned URL",
                content: {
                    "application/json": {
                        schema: resolver(needsConsentResponseSchema),
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

        // Check if GitHub App is configured
        const appId = c.env.GITHUB_APP_ID;
        const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
        if (!appId || !privateKey) {
            return c.json(
                {
                    error: "GitHub App not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
                },
                400
            );
        }

        try {
            const gh = new GitHubApp(appId, privateKey);
            const [owner, name] = repo.split("/") as [string, string];
            const tokenService = new TokenService(c.env.KV);

            // Determine base URL for consent redirect
            const url = new URL(c.req.url);
            const baseUrl = `${url.protocol}//${url.host}`;

            // Check consent FIRST — only create repo when token is being issued
            const hasConsent = await tokenService.checkConsent(repo, scopes);

            if (!hasConsent) {
                const consentUrl =
                    `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                    `&scopes=${encodeURIComponent(scopes.join(","))}`;
                return c.json(
                    { status: "needs_consent", url: consentUrl },
                    202
                );
            }

            // Consent exists: check cache first to avoid redundant GitHub API calls
            const cached = await tokenService.getCachedToken(repo, scopes);
            if (cached) {
                return c.json({
                    status: "ok",
                    token: cached.token,
                    expires_at: cached.expires_at,
                });
            }

            // No cache hit: create repo if needed, then issue token
            await gh.ensureRepoExists(owner, name);
            const tokenResult = await gh.requestToken(scopes, owner);
            await tokenService.cacheToken(
                repo,
                scopes,
                tokenResult.token,
                tokenResult.expires_at
            );

            return c.json({
                status: "ok",
                token: tokenResult.token,
                expires_at: tokenResult.expires_at,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ error: msg }, 500);
        }
    }
);
