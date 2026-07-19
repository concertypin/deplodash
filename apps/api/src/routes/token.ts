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
import { bodyLimit } from "hono/body-limit";
import { TokenService } from "@/token/service";
import { GitHubApp } from "@/github/app";
import { addWaiter } from "@/token/wait-notifier";
import { encryptWith, getOrInitKey } from "@/crypto";
import { permissionsFromScopes } from "@/github/scopes";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const requestTokenSchema = z
    .object({
        repo: z
            .string()
            .regex(
                /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9-._]+$/,
                "Invalid repository format"
            ),
        scopes: z.array(z.string().min(1)).min(1).default(["contents:read"]),
    })
    .transform(({ repo, scopes }) => {
        const [owner, name] = repo.split("/");
        return { repo, owner: owner!, name: name!, scopes };
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
    /** Encrypted original scope context for integrity verification. */
    requested_scopes_enc: z.string().optional(),
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
    bodyLimit({ maxSize: 50 * 1024 }),
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
        const { repo, owner, name, scopes } = c.req.valid("json");

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
            const gh = new GitHubApp(appId, privateKey, c.env.KV);
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

                // Encrypt the original scope request so consent.ts can verify scope integrity
                let requested_scopes_enc: string | undefined;
                if (c.env.ENCRYPTION_SECRET) {
                    const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
                    requested_scopes_enc = await encryptWith(
                        key,
                        JSON.stringify({
                            version: 1,
                            purpose: "consent-request",
                            scopes: scopes.join(","),
                            repo,
                            agent_id: agentId,
                        }),
                        "consent-request"
                    );
                }

                let consentUrl =
                    `${baseUrl}/auth/consent?repo=${encodeURIComponent(repo)}` +
                    `&scopes=${encodeURIComponent(scopes.join(","))}` +
                    `&agent_id=${encodeURIComponent(agentId)}`;
                if (requested_scopes_enc) {
                    consentUrl += `&requested_scopes_enc=${encodeURIComponent(requested_scopes_enc)}`;
                }

                return c.json(
                    {
                        status: "needs_consent",
                        url: consentUrl,
                        requested_scopes: scopes,
                        requested_scopes_enc,
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

            // Determine repo creation permissions
            const perms = permissionsFromScopes(effectiveScopes);
            const allowCreate = perms.administration === "write";
            await gh.ensureRepoExists(owner, name, allowCreate);
            const tokenResult = await gh.requestToken(
                effectiveScopes,
                owner,
                name
            );
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

tokenRouter.on(
    "QUERY",
    "/wait",
    bodyLimit({ maxSize: 50 * 1024 }),
    agentAuthMiddleware(),
    describeRoute({
        description:
            "Wait for a user to approve a token request (Long Polling)",
        responses: {
            204: {
                description: "Consent granted",
            },
            403: {
                description:
                    "Timeout (Consent not granted within the wait period)",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
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
        const agentId = c.get("agent_id")!;
        // Rate limiting — per-agent throttle
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
        const tokenService = new TokenService(c.env.KV);

        // First check if consent is already granted
        const effectiveScopes = await tokenService.findConsentScopes(
            agentId,
            repo,
            scopes
        );
        if (effectiveScopes) {
            return new Response(null, { status: 204 });
        }

        // Wait for up to 1 minute 30 seconds (90s)
        const TIMEOUT_MS = 90 * 1000;
        const POLL_INTERVAL_MS = 5000;

        return new Promise<Response>((resolve) => {
            let finished = false;

            // 1. Setup in-isolate module-level Map for instant notification
            const removeWaiter = addWaiter(repo, agentId, () => {
                void (async () => {
                    try {
                        // Double check with KV to be sure
                        const currentScopes =
                            await tokenService.findConsentScopes(
                                agentId,
                                repo,
                                scopes
                            );
                        if (currentScopes) {
                            finishWithSuccess();
                        }
                    } catch (e) {
                        console.error("Error in wait-notifier listener", e);
                    }
                })();
            });

            const timeoutId = setTimeout(() => {
                finishWithTimeout();
            }, TIMEOUT_MS);

            const pollIntervalId = setInterval(() => {
                void (async () => {
                    try {
                        const currentScopes =
                            await tokenService.findConsentScopes(
                                agentId,
                                repo,
                                scopes
                            );
                        if (currentScopes) {
                            finishWithSuccess();
                        }
                    } catch (e) {
                        console.error("Error polling for consent", e);
                    }
                })();
            }, POLL_INTERVAL_MS);

            const cleanup = () => {
                if (finished) return;
                finished = true;

                clearTimeout(timeoutId);
                clearInterval(pollIntervalId);
                removeWaiter();

                if (c.req.raw.signal) {
                    c.req.raw.signal.removeEventListener("abort", onAbort);
                }
            };

            const finishWithSuccess = () => {
                cleanup();
                resolve(new Response(null, { status: 204 }));
            };

            const finishWithTimeout = () => {
                cleanup();
                resolve(
                    c.json(
                        { error: "Timeout waiting for consent approval" },
                        403
                    )
                );
            };

            const onAbort = () => {
                cleanup();
                resolve(new Response(null, { status: 499 }));
            };

            // Cloudflare Workers specific: Ensure the promise resolves if the client disconnects
            if (c.req.raw.signal) {
                c.req.raw.signal.addEventListener("abort", onAbort);
            }
        });
    }
);
