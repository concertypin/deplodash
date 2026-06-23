# Security Design Notes

This file documents security decisions, intentional design choices, and excluded
findings that are not bugs — for future reviewers and agents.

---

## Agent Token No Expiry (src/middleware/agent-auth.ts)

**Status**: Intentional.

Agent tokens are opaque strings stored in KV without an expiry mechanism.
They remain valid until explicitly revoked via the admin API.

Rationale:

- Tokens are pre-provisioned, not self-service
- Admin can revoke leaked tokens immediately
- Adding expiry (TTL or age check) would require re-provisioning workflows
  without proportional security benefit in the current threat model

---

## Consent Scope Inflation (src/routes/consent.tsx — encrypted field guard)

**Status**: Intentional / Over-constraint removed.

The encrypted `requested_scopes_enc` field provides integrity for the UI
(showing the user what the agent originally requested) but is not a security
boundary. The authenticated GitHub user is the authority on what scopes to
grant — they may approve wider scopes than the agent requested.

The plaintext fallback when the encrypted field is absent is not a security
issue because:

- The user is already authenticated via GitHub OAuth (authGuard)
- SameSite=Strict cookies prevent CSRF-based form modification
- The user is delegating their own permissions, not someone else's

---

## Admin Revoke Audit Trail (src/routes/admin.ts)

**Status**: Not a security vulnerability.

Token revocation via the admin API lacks logging of who performed the action.
This is an operational gap, not a security boundary bypass:

- Only users listed in `GITHUB_ADMIN_USERS` can revoke tokens (RBAC enforced)
- Cloudflare Workers logs capture HTTP-level request metadata
- Audit logging is desirable for compliance but does not change the threat model

---

## KV List Pagination Gaps (src/middleware/agent-auth.ts, src/token-service.ts)

**Status**: Technical debt. Tracked in AGENTS.md.

`listAgentTokens()` and `listConsents()` do not handle `kv.list()` cursor-based
pagination (max 1000 keys per page). At current deployment scale this is not
a functional issue. Should be fixed before the repository grows beyond 1000
agent tokens or consent records.

---

## CDN Dependencies + CSP unsafety (src/views/Layout.tsx)

**Status**: Technical debt. Tracked in AGENTS.md.

Tailwind, DaisyUI, and Lucide loaded from external CDNs. CSP uses
`unsafe-inline` in `script-src`. Should be bundled and have CSP tightened
before production deployment.
