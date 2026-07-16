# Security Design Notes

This file documents security decisions, intentional design choices, and excluded
findings that are not bugs — for future reviewers and agents.

---

## Agent Token No Expiry (src/middleware/agent-auth.ts)

**Status**: Intentional.

Agent tokens are opaque strings stored in KV without an expiry mechanism.
They remain valid until explicitly revoked via the user dashboard or CLI.

The `granted_by` field (GitHub login of the user who approved) is now also
recorded and enforced on revocation (see D-001 below).

Rationale:

- Tokens are pre-provisioned, not self-service
- Admin can revoke leaked tokens immediately
- Adding expiry (TTL or age check) would require re-provisioning workflows
  without proportional security benefit in the current threat model

---

## Consent Scope Inflation (src/routes/consent.ts — encrypted field guard)

**Status**: Fixed / Now enforced.

Previously the encrypted `requested_scopes_enc` field was purely optional —
a best-effort integrity hint. The code has been hardened: when
`ENCRYPTION_SECRET` is configured, the encrypted field is **required**. If
absent, the request is rejected with 400.

Rationale for the change:

- Prevents MITM-style tampering with hidden form fields
- Binds the consent to the original {scopes, repo, agent_id} tuple
- Cross-repo replay and cross-agent redirect are blocked by cryptographic
  context binding

The `granted_by` field (GitHub login of the user who approved) is now also
recorded and enforced on revocation (see D-001 below).

---

## Agent Token Revocation (src/routes/user.ts)

**Status**: User-managed (dashboard).

Users can revoke their own tokens via the dashboard. Revocation is enforced
by ownership check: only the user who created the token (`created_by`) can
revoke it. Cross-user revocation returns 403.

The CLI script (`scripts/agent-token-manager.ts`) can still bypass ownership
for emergency revocation by an operator with KV access.

Cloudflare Workers logs capture HTTP-level request metadata for audit.

---

## Resolved Items (from SECURITY_TODO.md)

### D-001 — Cross-user Consent Exposure (src/token-service.ts, src/routes/consent.ts)

**Status**: Resolved.

`listConsents()` now accepts an optional `grantedBy` parameter — only records
with a matching `granted_by` field are returned. The dashboard calls
`listConsents(user.login)` so each user sees only their own consents.

`revokeConsent()` has a `caller` parameter. When provided, the stored
`granted_by` is checked before deletion; a mismatch throws
`ConsentOwnershipError`. `POST /api/consent/revoke` passes the authenticated
GitHub user as the caller.

### F-DIS-004 — Token API Rate Limiting (src/routes/token.ts, wrangler.json)

**Status**: Resolved.

Cloudflare's native `ratelimit` binding is configured as `TOKEN_RATE_LIMITER`
(simple: 100 requests per 60 seconds per `agent_id`). The binding is optional
in the `Env` type — if absent the check is skipped (graceful for dev/test).
When the limit is exceeded the agent receives a 429 response before any
GitHub API call is made.

### M-003 — GitHub API Error Leak (src/github-app.ts, src/routes/token.ts)

**Status**: Resolved.

All GitHub API response bodies have been removed from thrown errors in
`github-app.ts` — only the HTTP status code remains. In `token.ts` the catch
block uses a `KNOWN_SAFE_ERRORS` allowlist: matching messages pass through,
everything else is replaced with a generic fallback.

## KV List Pagination Gaps (src/middleware/agent-auth.ts, src/token-service.ts)

**Status**: Technical debt. Tracked in AGENTS.md.

`listAgentTokens()` and `listConsents()` do not handle `kv.list()` cursor-based
pagination (max 1000 keys per page). At current deployment scale this is not
a functional issue. Should be fixed before the repository grows beyond 1000
agent tokens or consent records.

---

## ~~CDN Dependencies + CSP unsafety~~ (RESOLVED — Svelte migration)

**Status**: Resolved.

Previously, the Hono JSX views (`src/views/`) loaded Tailwind, DaisyUI, and
Lucide from external CDNs with `unsafe-inline` in CSP. The frontend migration
to Svelte SSG (2026-07) replaces this entirely:

- Tailwind v4 + DaisyUI 5 are installed via npm and bundled into the production
  JS/CSS bundle via Vite/Rolldown — no CDN dependencies.
- CSP headers are no longer relevant since assets are served from the same
  origin (Cloudflare Workers static assets).
- The old `src/views/` directory has been removed.
