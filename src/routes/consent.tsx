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
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token-service";
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
            })
        ),
        (c) => {
            const { repo, scopes } = c.req.valid("query");
            const html = renderPage(
                <ConsentPage repo={repo} scopes={scopes} />
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
                // scopes can be a single string (legacy) or array of strings (granular checkboxes)
                scopes: z.union([z.string(), z.array(z.string())]),
                requested_scopes: z.string().optional(),
            })
        ),
        async (c) => {
            const {
                repo,
                scopes: rawScopes,
                requested_scopes,
            } = c.req.valid("form");
            const tokenService = new TokenService(c.env.KV);
            try {
                // Normalize scopes — handle both single comma-separated string and array from checkboxes
                const scopeList: string[] = Array.isArray(rawScopes)
                    ? rawScopes.map((s) => s.trim()).filter(Boolean)
                    : rawScopes
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean);
                // Parse the originally requested scopes for audit tracking
                const requestedList: string[] | undefined = requested_scopes
                    ? requested_scopes
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : undefined;
                await tokenService.recordConsent(
                    repo,
                    scopeList,
                    undefined,
                    requestedList
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
            })
        ),
        async (c) => {
            const { repo, scopes } = c.req.valid("form");
            const tokenService = new TokenService(c.env.KV);
            try {
                const scopeList = scopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                await tokenService.revokeConsent(repo, scopeList);
                return c.redirect("/");
            } catch (err: unknown) {
                console.error("consent: failed to revoke consent", err);
                return c.redirect("/?error=Failed+to+revoke+consent");
            }
        }
    );
