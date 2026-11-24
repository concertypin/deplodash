/**
 * OIDC identity token routes — mint short-lived ID tokens for an agent so
 * Workload Identity Federation (GCP first) can exchange them for cloud
 * credentials.
 *
 * Mounted at /api/oidc — paths are relative (/api/oidc/token).
 *
 * Flow:
 *   1. Agent POST /api/oidc/token with Bearer token + { audience }
 *   2. If the agent's owner approved the audience → signed ID token (200)
 *   3. Otherwise → needs_consent with URL (202); QUERY /api/oidc/wait blocks
 *      until approval
 */

import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";
import type { HonoEnv } from "@/types";
import { agentAuthMiddleware, ensureAgentUid } from "@/middleware/agent-auth";
import { buildOidcConsentUrl } from "@/helpers";
import { isRateLimited } from "@/rate-limit";
import { getIssuerConfig } from "@/oidc/issuer";
import { parseAudience } from "@/oidc/audience";
import { OidcConsentService, oidcWaiterKey } from "@/oidc/consent";
import { ID_TOKEN_TYPE, agentSubject, mintIdToken } from "@/oidc/token";
import { addWaiter } from "@/token/wait-notifier";
import { waitForApproval } from "@/token/long-poll";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const requestSchema = z.object({
    audience: z.string().min(1).max(512),
});

const tokenResponseSchema = z.object({
    status: z.literal("ok"),
    id_token: z.string(),
    token_type: z.literal(ID_TOKEN_TYPE),
    expires_at: z.string(),
    subject: z.string(),
});

const needsConsentResponseSchema = z.object({
    status: z.literal("needs_consent"),
    url: z.string(),
    subject: z.string(),
});

const errorResponseSchema = z.object({ error: z.string() });

const errorContent = {
    "application/json": { schema: resolver(errorResponseSchema) },
};

const UNSUPPORTED_AUDIENCE =
    "Unsupported audience. Expected a GCP Workload Identity provider: " +
    "https://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>";

// ─── Routes ──────────────────────────────────────────────────────────────────

export const oidcRouter = new Hono<HonoEnv>()
    .post(
        "/token",
        bodyLimit({ maxSize: 8 * 1024 }),
        agentAuthMiddleware(),
        describeRoute({
            description:
                "Mint a short-lived OIDC identity token for Workload Identity Federation",
            responses: {
                200: {
                    description: "Identity token issued",
                    content: {
                        "application/json": {
                            schema: resolver(tokenResponseSchema),
                        },
                    },
                },
                202: {
                    description:
                        "Consent required — the agent's owner must approve the audience via the returned URL",
                    content: {
                        "application/json": {
                            schema: resolver(needsConsentResponseSchema),
                        },
                    },
                },
                400: { description: "Bad request", content: errorContent },
                401: {
                    description: "Invalid or missing agent token",
                    content: errorContent,
                },
                429: { description: "Rate limited", content: errorContent },
                503: {
                    description: "OIDC issuer not configured",
                    content: errorContent,
                },
            },
        }),
        validator("json", requestSchema),
        async (c) => {
            const config = getIssuerConfig(c.env);
            if (!config) {
                return c.json({ error: "OIDC issuer is not configured" }, 503);
            }
            const { token, info } = c.get("agent")!;
            const audience = parseAudience(c.req.valid("json").audience);
            if (!audience) return c.json({ error: UNSUPPORTED_AUDIENCE }, 400);

            try {
                const agentUid = await ensureAgentUid(c.env.KV, token, info);
                // Keyed by uid: agent_id is user-chosen and not unique across
                // owners, so it would let one user throttle another's agent.
                if (
                    await isRateLimited(
                        c.env.TOKEN_RATE_LIMITER,
                        `oidc:${agentUid}`
                    )
                ) {
                    return c.json(
                        { error: "Rate limited. Try again later." },
                        429
                    );
                }
                const subject = agentSubject(agentUid);
                const consents = new OidcConsentService(c.env.KV);
                if (!(await consents.hasConsent(agentUid, audience.audience))) {
                    const url = new URL(c.req.url);
                    return c.json(
                        {
                            status: "needs_consent",
                            url: buildOidcConsentUrl(
                                `${url.protocol}//${url.host}`,
                                {
                                    agentId: info.agent_id,
                                    agentUid,
                                    audience: audience.audience,
                                }
                            ),
                            subject,
                        },
                        202
                    );
                }

                const { idToken, expiresAt } = await mintIdToken(config, {
                    agentUid,
                    agentId: info.agent_id,
                    ownerGithubId: info.created_by_id,
                    audience: audience.audience,
                });
                return c.json({
                    status: "ok",
                    id_token: idToken,
                    token_type: ID_TOKEN_TYPE,
                    expires_at: expiresAt,
                    subject,
                });
            } catch (err: unknown) {
                // Never echo internals (key material, KV errors) to agents.
                console.error("oidc: failed to issue identity token", err);
                return c.json(
                    {
                        error: "An internal error occurred while issuing the identity token.",
                    },
                    500
                );
            }
        }
    )
    .on(
        "QUERY",
        "/wait",
        bodyLimit({ maxSize: 8 * 1024 }),
        agentAuthMiddleware(),
        describeRoute({
            description:
                "Wait for the agent's owner to approve an OIDC audience (Long Polling)",
            responses: {
                204: { description: "Consent granted" },
                400: { description: "Bad request", content: errorContent },
                401: {
                    description: "Invalid or missing agent token",
                    content: errorContent,
                },
                403: {
                    description:
                        "Timeout (Consent not granted within the wait period)",
                    content: errorContent,
                },
            },
        }),
        validator("json", requestSchema),
        async (c) => {
            const { token, info } = c.get("agent")!;
            const audience = parseAudience(c.req.valid("json").audience);
            if (!audience) return c.json({ error: UNSUPPORTED_AUDIENCE }, 400);

            const agentUid = await ensureAgentUid(c.env.KV, token, info);
            if (
                await isRateLimited(
                    c.env.TOKEN_RATE_LIMITER,
                    `oidc:${agentUid}`
                )
            ) {
                return c.json({ error: "Rate limited. Try again later." }, 429);
            }
            const consents = new OidcConsentService(c.env.KV);
            const check = () =>
                consents.hasConsent(agentUid, audience.audience);
            if (await check()) return new Response(null, { status: 204 });

            const outcome = await waitForApproval({
                check,
                subscribe: (onNotify) =>
                    addWaiter(
                        oidcWaiterKey(audience.audience),
                        agentUid,
                        onNotify
                    ),
                signal: c.req.raw.signal,
            });
            if (outcome === "approved") {
                return new Response(null, { status: 204 });
            }
            if (outcome === "aborted") {
                return new Response(null, { status: 499 });
            }
            return c.json(
                { error: "Timeout waiting for consent approval" },
                403
            );
        }
    );
