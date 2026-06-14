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
 */

import { Hono } from "hono";
import { validator } from "hono-openapi";
import * as z from "zod";
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token-service";
import { escapeHtml } from "@/helpers";

// ─── HTML templates ─────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<string, string> = {
    "contents:read": "Read repository contents",
    "contents:write": "Read & write repository contents",
    "workflows:write": "Read & write workflow files",
    admin: "Full admin access",
};

function scopeDescription(scopes: string): string {
    return scopes
        .split(",")
        .map((s) => `• ${SCOPE_LABELS[s.trim()] ?? escapeHtml(s.trim())}`)
        .join("<br>");
}

/**
 * Render the consent page.
 */
function renderConsentPage(params: {
    repo: string;
    scopes: string;
    error?: string;
    success?: boolean;
}): string {
    const { repo, scopes, error, success } = params;
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'">
<title>Authorize Agent — ${escapeHtml(repo)}</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content w-full max-w-lg">
    <div class="card bg-base-200 shadow-xl w-full">
      <div class="card-body">
        <h2 class="card-title mb-2">🔑 Authorize Agent Access</h2>
        <p class="text-sm text-base-content/60 mb-4">
          An agent is requesting access to a repository. Review the details below.
        </p>
        ${error ? `<div class="alert alert-error mb-4">${escapeHtml(error)}</div>` : ""}
        ${success ? `<div class="alert alert-success mb-4">✅ Consent recorded. The agent can now request tokens.</div>` : ""}
        <div class="bg-base-300 rounded-lg p-4 mb-4">
          <div class="font-semibold mb-1">Repository</div>
          <div class="font-mono text-sm">${escapeHtml(repo)}</div>
          <div class="font-semibold mt-3 mb-1">Requested Permissions</div>
          <div class="text-sm">${scopeDescription(scopes)}</div>
        </div>
        ${
            !success
                ? `
        <form method="POST" action="/auth/consent">
          <input type="hidden" name="repo" value="${escapeHtml(repo)}">
          <input type="hidden" name="scopes" value="${escapeHtml(scopes)}">
          <div class="card-actions justify-end">
            <a href="/" class="btn btn-ghost">Deny</a>
            <button type="submit" class="btn btn-primary">Confirm</button>
          </div>
        </form>`
                : `
        <div class="card-actions justify-end">
          <a href="/" class="btn btn-primary">Back to Dashboard</a>
        </div>`
        }
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /auth — relative paths

export const consentRouter = new Hono<HonoEnv>();

// ── GET /auth/consent — Show consent page ────────────────────────────

consentRouter.get(
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
        const html = renderConsentPage({ repo, scopes });
        return c.html(html);
    }
);

// ── POST /auth/consent — Process consent ─────────────────────────────

consentRouter.post(
    "/consent",
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
            await tokenService.recordConsent(repo, scopeList);
            const html = renderConsentPage({
                repo,
                scopes,
                success: true,
            });
            return c.html(html);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const html = renderConsentPage({ repo, scopes, error: msg });
            return c.html(html, 400);
        }
    }
);
