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
import { validator } from "hono-openapi";
import * as z from "zod";
import { COMPOUND_SCOPES, SCOPE_LABELS, type HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token-service";
import { encryptWith, decryptWith, getOrInitKey } from "@/crypto";
import { renderPage, ConsentPage } from "@/views";

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /auth — relative paths

export const consentRouter = new Hono<HonoEnv>()
    .get(
        "/consent",
        authGuard(),
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
        validator(
            "form",
            z.object({
                repo: z.string().min(1),
                // scopes can be a single string (legacy) or array of strings (granular checkboxes).
                // Optional because unchecking all checkboxes means nothing is posted for scopes.
                scopes: z.union([z.string(), z.array(z.string())]).optional(),
                requested_scopes: z.string().optional(),
                requested_scopes_enc: z.string().optional(),
                agent_id: z.string().optional(),
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
            // Validate authenticated consent context.
            // If encrypted data is provided, decrypt and verify repo+agent_id match.
            // When ENCRYPTION_SECRET is configured but no encrypted field is submitted,
            // the request is rejected (prevents subset-validation bypass).
            let requested_scopes = rawRequestedScopes;
            if (requested_scopes_enc) {
                try {
                    const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
                    const decrypted = await decryptWith(
                        key,
                        requested_scopes_enc
                    );
                    if (decrypted === null) throw new Error("Decrypt failed");
                    const ctx = JSON.parse(decrypted) as {
                        scopes: string;
                        repo?: string;
                        agent_id?: string;
                    };
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
                            scopes=""
                            error="Invalid consent request. Please try again from the agent's link."
                        />
                    );
                    return c.html(html, 400);
                }
            } else if (!rawRequestedScopes && c.env.ENCRYPTION_SECRET) {
                // Encryption configured but no scope info submitted — reject
                const html = renderPage(
                    <ConsentPage
                        repo={repo}
                        scopes=""
                        error="Invalid consent request. Please try again from the agent's link."
                    />
                );
                return c.html(html, 400);
            }
            const tokenService = new TokenService(c.env.KV);
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
                // Get the authenticated GitHub user for audit trail (non-fatal)
                const ghClient = c.get("client")!;
                let grantedBy: string | undefined;
                try {
                    const ghUser = await ghClient.getUser();
                    grantedBy = ghUser.login;
                } catch {
                    // GitHub API call failed — consent still works, just without audit trail
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
                const knownScopes = new Set([
                    ...Object.keys(SCOPE_LABELS),
                    ...COMPOUND_SCOPES,
                ]);
                const unknownScopes = scopeList.filter(
                    (s) => !knownScopes.has(s)
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
        validator(
            "form",
            z.object({
                repo: z.string().min(1),
                scopes: z.string().min(1),
                agent_id: z.string().optional(),
            })
        ),
        async (c) => {
            const { repo, scopes, agent_id } = c.req.valid("form");
            const tokenService = new TokenService(c.env.KV);
            try {
                const scopeList = scopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                await tokenService.revokeConsent(
                    agent_id ?? "",
                    repo,
                    scopeList
                );
                console.log(
                    `REVOKE: repo=${repo} scopeList=${JSON.stringify(
                        scopeList
                    )} scopes=${scopes}`
                );
                return c.redirect("/");
            } catch (err: unknown) {
                console.error("consent: failed to revoke consent", err);
                return c.redirect("/?error=Failed+to+revoke+consent");
            }
        }
    );
