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
import { TokenService } from "@/token/service";
import { GitHubApp } from "@/github/app";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const requestTokenSchema = z.object({
    repo: z.templateLiteral([z.string(), z.literal("/"), z.string()]),
    scopes: z.array(z.string().min(1)).min(1).default(["contents:read"]),
});

const tokenResponseSchema = z.object({
    status: z.literal("ok"),
    token: z.string(),
    expires_at: z.string(),
    effective_scopes: z.array(z.string()).optional(),
});

const needsConsentResponseSchema = z.object({
    status: z.literal("needs_consent"),
    url: z.string(),
    /** The scopes the agent requested. */
    requested_scopes: z.array(z.string()).optional(),
    /** Scopes the user has already approved for this repo (if any). */
    approved_scopes: z.array(z.string()).optional(),
});

const errorResponseSchema = z.object({
    error: z.string(),
});

// ─── Safe error patterns (messages that are safe to return to callers) ────────

const KNOWN_SAFE_ERRORS: RegExp[] = [
    /^GitHub App is not installed/i,
    /^Failed to check (org|user) installation/i,
    /^Failed to check repo existence/i,
    /^Failed to create repo/i,
    /^GitHub App token request failed/i,
    /^Could not resolve installation/i,
];

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
                500
            );
        }

        try {
            const gh = new GitHubApp(appId, privateKey);
            const [owner, name] = repo.split("/") as [string, string];
            const tokenService = new TokenService(c.env.KV);
            const agentId = c.get("agent_id")!;

            // Rate limiting — per-agent throttle to protect GitHub API quota
            const rateLimiter = c.env.TOKEN_RATE_LIMITER;
            if (rateLimiter) {
                try {
                    const { success } = await rateLimiter.limit({
                        key: agentId,
                    });
                    if (!success) {
                        return c.json(
                            { error: "Rate limited. Try again later." },
                            429
                        );
                    }
                } catch {
                    // Rate limiter unavailable (e.g., local dev) — proceed
                }
            }

            // Determine base URL for consent redirect
            const url = new URL(c.req.url);
            const baseUrl = `${url.protocol}//${url.host}`;

            // Check consent — supports granular approval (user may have approved a subset)
            const effectiveScopes: string[] | null =
                await tokenService.findConsentScopes(agentId, repo, scopes);

            if (!effectiveScopes) {
                // No matching consent found — check if the user has approved ANY scopes for this repo
                const approvedScopes = await tokenService.getAllApprovedScopes(
                    agentId,
                    repo
                );
                const consentUrl =
                    `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                    `&scopes=${encodeURIComponent(scopes.join(","))}` +
                    `&agent_id=${encodeURIComponent(agentId)}`;

                return c.json(
                    {
                        status: "needs_consent",
                        url: consentUrl,
                        requested_scopes: scopes,
                        approved_scopes:
                            approvedScopes.length > 0
                                ? approvedScopes
                                : undefined,
                    },
                    202
                );
            }

            // Effective scopes may differ from requested if user approved only a subset
            // Check cache for the effective scopes
            const cached = await tokenService.getCachedToken(
                agentId,
                repo,
                effectiveScopes
            );
            if (cached) {
                return c.json({
                    status: "ok",
                    token: cached.token,
                    expires_at: cached.expires_at,
                    effective_scopes: effectiveScopes,
                });
            }

            // No cache hit: create repo if needed, then issue token with effective scopes
            await gh.ensureRepoExists(owner, name);
            const tokenResult = await gh.requestToken(effectiveScopes, owner);
            await tokenService.cacheToken(
                agentId,
                repo,
                effectiveScopes,
                tokenResult.token,
                tokenResult.expires_at
            );

            return c.json({
                status: "ok",
                token: tokenResult.token,
                expires_at: tokenResult.expires_at,
                effective_scopes: effectiveScopes,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            // Sanitize: only pass through known-safe messages; use generic fallback
            const safe = KNOWN_SAFE_ERRORS.some((p) => p.test(msg))
                ? msg
                : "An internal error occurred while processing the token request.";
            return c.json({ error: safe }, 500);
        }
    }
);
