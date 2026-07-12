/**
 * Consent routes — User-facing page for approving agent token requests.
 *
 * Mounted at /auth — paths are relative (/auth/consent).
 *
 * Flow:
 *   1. GET /auth/consent?repo=owner/repo&scopes=contents:write
 *      → Renders DaisyUI consent page (requires auth)
 *   2. POST /auth/consent (form body: repo, scopes)
 *      → Stores consent in KV, redirects with success message
 *   3. POST /auth/revoke (form body: repo, scopes)
 *      → Revokes consent, redirects to dashboard
 */

import { Hono } from "hono";
import { validator, describeRoute } from "hono-openapi";
import * as z from "zod";
import { COMPOUND_SCOPES, SCOPE_LABELS } from "@/github/scopes";
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token/service";
import { ConsentOwnershipError } from "@/errors";
import { encryptWith, decryptWith, getOrInitKey } from "@/crypto";
import { renderPage, ConsentPage } from "@/views";
import { notifyWaiters } from "@/token/wait-notifier";

// Static set of all known scope strings — defined once at module level to avoid
// reallocation on every request.
const KNOWN_SCOPES = new Set([
    ...Object.keys(SCOPE_LABELS),
    ...COMPOUND_SCOPES,
]);

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /auth — relative paths
const zSchema = z.object({
    scopes: z.string(),
    repo: z.string().min(1),
    agent_id: z.string().optional(),
});

export const consentRouter = new Hono<HonoEnv>()
    .get(
        "/consent",
        authGuard(),
        describeRoute({
            description:
                "Show user-facing consent page for agent token request",
            responses: {
                200: {
                    description: "HTML consent page",
                    content: {
                        "text/html": {
                            schema: { type: "string" },
                        },
                    },
                },
            },
        }),
        validator(
            "query",
            z.object({
                repo: z.string().min(1),
                scopes: z.string().min(1),
                agent_id: z.string().optional(),
            })
        ),
        async (c) => {
            const { repo, scopes, agent_id } = c.req.valid("query");
            // Encrypt the requested scopes + context so they cannot be tampered with.
            // The POST handler will decrypt and verify repo+agent_id match the form.
            // If encryption fails, the encrypted field is omitted; the POST handler
            // will reject requests missing it when ENCRYPTION_SECRET is configured.
            let requestedScopesEnc: string | undefined;
            try {
                const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
                const payload = JSON.stringify({ scopes, repo, agent_id });
                requestedScopesEnc = await encryptWith(key, payload);
            } catch {
                // Encryption failed — proceed without protection (best-effort)
            }
            const html = renderPage(
                <ConsentPage
                    repo={repo}
                    scopes={scopes}
                    {...(requestedScopesEnc ? { requestedScopesEnc } : {})}
                    {...(agent_id ? { agentId: agent_id } : {})}
                />
            );
            return c.html(html);
        }
    )
    .post(
        "/consent",
        authGuard(),
        describeRoute({
            description: "Approve agent token request and record consent",
            responses: {
                302: {
                    description: "Redirect to home page or callback URL",
                },
                400: {
                    description: "Invalid consent request",
                    content: {
                        "text/html": {
                            schema: { type: "string" },
                        },
                    },
                },
            },
        }),
        validator(
            "form",
            z.object({
                repo: z.string().min(1),
                // scopes can be a single string (legacy) or array of strings (granular checkboxes).
                // Optional because unchecking all checkboxes means nothing is posted for scopes.
                scopes: z.union([z.string(), z.array(z.string())]).optional(),
                requested_scopes: z.string().optional(),
                requested_scopes_enc: z.string().optional(),
                agent_id: z.string().min(1).optional(),
            })
        ),
        async (c) => {
            const {
                repo,
                scopes: rawScopes,
                requested_scopes: rawRequestedScopes,
                requested_scopes_enc,
                agent_id,
            } = c.req.valid("form");
            // CSRF protection — validate Origin header
            const origin = c.req.header("Origin");
            if (origin && origin !== new URL(c.req.url).origin) {
                return c.text("CSRF detected", 403);
            }
            // Validate authenticated consent context.
            // If encrypted data is provided, decrypt and verify repo+agent_id match.
            // When ENCRYPTION_SECRET is configured but no encrypted field is submitted,
            // the request is rejected (prevents subset-validation bypass).
            let requested_scopes = rawRequestedScopes;
            if (c.env.ENCRYPTION_SECRET) {
                if (!requested_scopes_enc) {
                    const html = renderPage(
                        <ConsentPage
                            repo={repo}
                            scopes={rawScopes?.toString() ?? ""}
                            error="Invalid consent request. Missing encrypted payload."
                        />
                    );
                    return c.html(html, 400);
                }
                try {
                    const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
                    const decrypted = await decryptWith(
                        key,
                        requested_scopes_enc
                    );
                    if (decrypted === null) throw new Error("Decrypt failed");

                    const ctx = zSchema.parse(JSON.parse(decrypted));
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
                    const html = renderPage(
                        <ConsentPage
                            repo={repo}
                            scopes={rawScopes?.toString() ?? ""}
                            error="Invalid consent request. Please try again from the agent's link."
                        />
                    );
                    return c.html(html, 400);
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
                        return c.text("Rate limited. Try again later.", 429);
                    }
                } catch {
                    // Rate limiter unavailable (e.g., local dev) — proceed
                }
            }
            try {
                // Handle empty scopes — no checkboxes were checked
                if (!rawScopes) {
                    const html = renderPage(
                        <ConsentPage
                            repo={repo}
                            scopes=""
                            error="You must select at least one permission to proceed."
                        />
                    );
                    return c.html(html, 400);
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
                const requestedList: string[] | undefined = requested_scopes
                    ? requested_scopes
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : undefined;
                // Resolve the authenticated GitHub user for audit trail
                const ghClient = c.get("client")!;
                let grantedBy: string;
                try {
                    const ghUser = await ghClient.getUser();
                    grantedBy = ghUser.login;
                } catch {
                    // Cannot resolve identity — reject to avoid storing orphaned consent
                    const html = renderPage(
                        <ConsentPage
                            repo={repo}
                            scopes={rawScopes?.toString() ?? ""}
                            error="Failed to verify your identity. Please try again."
                        />
                    );
                    return c.html(html, 400);
                }

                // Validate that approved scopes are a subset of the originally requested scopes.
                // This prevents the consent page from being manipulated to grant wider permissions
                // than what the agent originally requested.
                if (requestedList) {
                    const invalidScopes = scopeList.filter(
                        (s) => !requestedList.includes(s)
                    );
                    if (invalidScopes.length > 0) {
                        const html = renderPage(
                            <ConsentPage
                                repo={repo}
                                scopes={requested_scopes ?? ""}
                                error={`Cannot approve scopes not in the original request: ${invalidScopes.join(", ")}`}
                            />
                        );
                        return c.html(html, 400);
                    }
                }

                // Validate that all scopes are known scope strings
                const unknownScopes = scopeList.filter(
                    (s) => !KNOWN_SCOPES.has(s)
                );
                if (unknownScopes.length > 0) {
                    const html = renderPage(
                        <ConsentPage
                            repo={repo}
                            scopes={
                                requested_scopes ?? rawScopes?.toString() ?? ""
                            }
                            error={`Unknown scope(s): ${unknownScopes.join(", ")}`}
                        />
                    );
                    return c.html(html, 400);
                }

                await tokenService.recordConsent(
                    agent_id ?? "",
                    repo,
                    scopeList,
                    requestedList,
                    grantedBy
                );

                // Notify any long-polling clients that consent was granted
                notifyWaiters(repo, agent_id ?? "");

                const successScopes = scopeList.join(",");
                const html = renderPage(
                    <ConsentPage
                        repo={repo}
                        scopes={successScopes}
                        success={true}
                    />
                );
                return c.html(html);
            } catch (err: unknown) {
                console.error("consent: failed to record consent", err);
                const html = renderPage(
                    <ConsentPage
                        repo={repo}
                        scopes={rawScopes?.toString() ?? ""}
                        error="Failed to record consent. Please try again."
                    />
                );
                return c.html(html, 400);
            }
        }
    )
    .post(
        "/revoke",
        authGuard(),
        describeRoute({
            description: "Revoke an agent token request consent",
            responses: {
                302: {
                    description: "Redirect to home page",
                },
                400: {
                    description: "Failed to revoke consent",
                    content: {
                        "text/html": {
                            schema: { type: "string" },
                        },
                    },
                },
            },
        }),
        validator(
            "form",
            z.object({
                repo: z.string().min(1),
                scopes: z.string().min(1),
                agent_id: z.string().min(1).optional(),
            })
        ),
        async (c) => {
            const { repo, scopes, agent_id } = c.req.valid("form");
            // CSRF protection — validate Origin header
            const origin = c.req.header("Origin");
            if (origin && origin !== new URL(c.req.url).origin) {
                return c.text("CSRF detected", 403);
            }
            // Rate limiting — per-IP throttle for consent endpoints
            const revokeRateLimiter = c.env.TOKEN_RATE_LIMITER;
            if (revokeRateLimiter) {
                try {
                    const { success } = await revokeRateLimiter.limit({
                        key: c.req.header("CF-Connecting-IP") || "unknown",
                    });
                    if (!success) {
                        return c.text("Rate limited. Try again later.", 429);
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
                    // Cannot verify identity — fail closed
                    return c.redirect(
                        "/?error=Failed+to+verify+identity.+Please+try+again."
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
                return c.redirect("/");
            } catch (err: unknown) {
                console.error("consent: failed to revoke consent", err);
                if (err instanceof ConsentOwnershipError) {
                    return c.redirect(
                        "/?error=Cannot+revoke+another+user%27s+consent"
                    );
                }
                return c.redirect("/?error=Failed+to+revoke+consent");
            }
        }
    );
