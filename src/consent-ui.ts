// Consent UI — User-facing page for approving agent token requests.
//
// Rendered via DaisyUI (like the existing HTML templates).
// The page shows:
//   - Which repo the agent wants access to
//   - What permissions are requested
//   - Confirm / Deny buttons

import { escapeHtml } from "./helpers.ts";

export interface ConsentPageParams {
  repo: string;
  scopes: string;
  redirectToken: string;
  error?: string;
  success?: boolean;
}

const SCOPE_LABELS: Record<string, string> = {
  "contents:read": "Read repository contents",
  "contents:write": "Read & write repository contents",
  "workflows:write": "Read & write workflow files",
  admin: "Full admin access",
};

function scopeDescription(scopes: string): string {
  return scopes
    .split(",")
    .map((s) => `• ${SCOPE_LABELS[s] ?? s}`)
    .join("\n");
}

export function renderConsentPage(params: ConsentPageParams): string {
  const { repo, scopes, error } = params;
  return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
        <div class="bg-base-300 rounded-lg p-4 mb-4 space-y-3">
          <div>
            <span class="text-xs text-base-content/40 uppercase tracking-wide">Repository</span>
            <p class="font-mono text-sm mt-1">${escapeHtml(repo)}</p>
          </div>
          <div>
            <span class="text-xs text-base-content/40 uppercase tracking-wide">Requested Permissions</span>
            <pre class="text-sm mt-1 whitespace-pre-wrap">${scopeDescription(scopes)}</pre>
          </div>
        </div>
        <form action="/auth/consent" method="POST" class="space-y-3">
          <input type="hidden" name="repo" value="${escapeHtml(repo)}">
          <input type="hidden" name="scopes" value="${escapeHtml(scopes)}">
          <input type="hidden" name="token" value="${escapeHtml(params.redirectToken)}">
          <div class="card-actions justify-end">
            <a href="/" class="btn btn-ghost">Deny</a>
            <button type="submit" class="btn btn-primary">Authorize</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}
