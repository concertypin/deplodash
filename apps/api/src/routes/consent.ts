/**
 * Consent routes — API endpoints for granting and revoking agent token consent.
 *
 * POST /api/consent          — grant consent for an agent
 * POST /api/consent/revoke   — revoke consent for an agent
 *
 * Both endpoints require a valid session cookie and return JSON.
 */

import { Hono } from "hono";
import { validator } from "hono-openapi";
import * as z from "zod";
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token/service";
import { ConsentOwnershipError } from "@/errors";
import { decryptWith, getOrInitKey } from "@/crypto";
import { notifyWaiters } from "@/token/wait-notifier";

// ─── Schema ──────────────────────────────────────────────────────────────────

const consentSchema = z.object({
    repo: z.string().min(1),
    scopes: z.union([z.string(), z.array(z.string())]).optional(),
    requested_scopes: z.string().optional(),
    requested_scopes_enc: z.string().optional(),
    agent_id: z.string().min(1).optional(),
});

const revokeSchema = z.object({
    repo: z.string().min(1),
    scopes: z.string().min(1),
    agent_id: z.string().min(1).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /api/consent — relative paths

export const consentRouter = new Hono<HonoEnv>()
    .post("/", authGuard(), validator("json", consentSchema), async (c) => {
        const {
            repo,
            scopes: rawScopes,
            requested_scopes: rawRequestedScopes,
            requested_scopes_enc,
            agent_id,
        } = c.req.valid("json");
        // CSRF protection — validate Origin header
        const origin = c.req.header("Origin");
        if (origin && origin !== new URL(c.req.url).origin) {
            return c.json({ error: "CSRF detected" }, 403);
        }
        // Validate authenticated consent context.
        // If encrypted data is provided, decrypt and verify repo+agent_id match.
        // When ENCRYPTION_SECRET is configured but no encrypted field is submitted,
        // the request is rejected (prevents subset-validation bypass).
        let requested_scopes = rawRequestedScopes;
        if (c.env.ENCRYPTION_SECRET) {
            if (!requested_scopes_enc) {
                return c.json(
                    {
                        error: "Invalid consent request. Missing encrypted payload.",
                    },
                    400
                );
            }
            try {
                const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
                const decrypted = await decryptWith(key, requested_scopes_enc);
                if (decrypted === null) throw new Error("Decrypt failed");
                const contextSchema = z.object({
                    scopes: z.string(),
                    repo: z.string().optional(),
                    agent_id: z.string().optional(),
                });
                const ctx = contextSchema.parse(JSON.parse(decrypted));
                // Verify repo binding — prevents cross-repo replay
                if (ctx.repo && ctx.repo !== repo) {
                    throw new Error("Repo mismatch");
                }
                // Verify agent_id binding when present — prevents cross-agent redirect
                if (ctx.agent_id && ctx.agent_id !== agent_id) {
                    throw new Error("Agent mismatch");
                }
                requested_scopes = ctx.scopes;
            } catch {
                return c.json(
                    {
                        error: "Invalid consent request. Please try again from the agent's link.",
                    },
                    400
                );
            }
        }
        const tokenService = new TokenService(c.env.KV);
        // Rate limiting — per-IP throttle for consent endpoints
        const consentRateLimiter = c.env.TOKEN_RATE_LIMITER;
        if (consentRateLimiter) {
            try {
                const { success } = await consentRateLimiter.limit({
                    key: c.req.header("CF-Connecting-IP") || "unknown",
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
        try {
            // Handle empty scopes — no checkboxes were checked
            if (!rawScopes) {
                return c.json(
                    {
                        error: "You must select at least one permission to proceed.",
                    },
                    400
                );
            }
            // Normalize scopes — handle both single comma-separated string and array from checkboxes.
            // Deduplicate to ensure clean data in KV.
            const scopeList: string[] = [
                ...new Set(
                    Array.isArray(rawScopes)
                        ? rawScopes.map((s) => s.trim()).filter(Boolean)
                        : rawScopes
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean)
                ),
            ];
            // Parse the originally requested scopes once and reuse for both
            // audit tracking and subset validation.
            const requestedList: string[] | undefined =
                typeof requested_scopes === "string"
                    ? requested_scopes
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : undefined;
            // Validate that approved scopes are a subset of the originally requested scopes.
            if (requestedList) {
                const invalidScopes = scopeList.filter(
                    (s) => !requestedList.includes(s)
                );
                if (invalidScopes.length > 0) {
                    return c.json(
                        {
                            error: `Cannot approve scopes not in the original request: ${invalidScopes.join(", ")}`,
                        },
                        400
                    );
                }
            }
            // Resolve the authenticated GitHub user for audit trail
            const ghClient = c.get("client")!;
            let grantedBy: string;
            try {
                const ghUser = await ghClient.getUser();
                grantedBy = ghUser.login;
            } catch {
                return c.json(
                    { error: "Failed to verify identity. Please try again." },
                    401
                );
            }
            // Grant all requested scopes — duplicates are handled by TokenService
            for (const scope of scopeList) {
                await tokenService.recordConsent(
                    agent_id ?? "",
                    repo,
                    [scope],
                    requestedList ?? undefined,
                    grantedBy
                );
            }
            console.log(
                `GRANT: repo=${repo} scopeList=${JSON.stringify(
                    scopeList
                )} scopes=${String(rawScopes ?? "")} grantedBy=${grantedBy}`
            );
            // Notify any waiters that consent has been granted
            notifyWaiters(repo, agent_id ?? "");
            return c.json({ status: "ok" });
        } catch (err: unknown) {
            console.error("consent: failed to grant consent", err);
            const msg =
                err instanceof Error ? err.message : "Failed to grant consent";
            return c.json({ error: msg }, 500);
        }
    })
    .post(
        "/revoke",
        authGuard(),
        validator("json", revokeSchema),
        async (c) => {
            const { repo, scopes, agent_id } = c.req.valid("json");
            // CSRF protection — validate Origin header
            const origin = c.req.header("Origin");
            if (origin && origin !== new URL(c.req.url).origin) {
                return c.json({ error: "CSRF detected" }, 403);
            }
            // Rate limiting — per-IP throttle for consent endpoints
            const revokeRateLimiter = c.env.TOKEN_RATE_LIMITER;
            if (revokeRateLimiter) {
                try {
                    const { success } = await revokeRateLimiter.limit({
                        key: c.req.header("CF-Connecting-IP") || "unknown",
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
            const client = c.get("client")!;
            const tokenService = new TokenService(c.env.KV);
            try {
                const scopeList = scopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                // Resolve the current user's GitHub login for ownership check
                let caller: string;
                try {
                    const user = await client.getUser();
                    caller = user.login;
                } catch {
                    return c.json(
                        {
                            error: "Failed to verify identity. Please try again.",
                        },
                        401
                    );
                }
                await tokenService.revokeConsent(
                    agent_id ?? "",
                    repo,
                    scopeList,
                    caller
                );
                console.log(
                    `REVOKE: repo=${repo} scopeList=${JSON.stringify(
                        scopeList
                    )} scopes=${scopes}`
                );
                return c.json({ status: "ok" });
            } catch (err: unknown) {
                console.error("consent: failed to revoke consent", err);
                if (err instanceof ConsentOwnershipError) {
                    return c.json(
                        { error: "Cannot revoke another user's consent" },
                        403
                    );
                }
                return c.json({ error: "Failed to revoke consent" }, 500);
            }
        }
    );
