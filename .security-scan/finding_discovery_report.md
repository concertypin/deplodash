# Finding Discovery Report — Round 01, Worker 01

## Target: deplodash / main branch issues not caught in dev/fix-consent-user-and-scope-validation

---

## F-001: Missing CSRF Protection on Consent and Revoke Forms

**Severity**: HIGH
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-352 (Cross-Site Request Forgery)  
**Location**: src/routes/consent.tsx — POST /auth/consent and POST /auth/revoke

**Description**: The POST handlers for /auth/consent and /auth/revoke accept form submissions without any CSRF token. An authenticated user who visits a malicious page while logged into deplodash could have their browser submit an unauthorized form, granting unintended permissions or revoking existing consent.

**Proof**: Neither the GET handler that renders the form, nor the POST handler that processes it, generates or validates a CSRF token. SameSite=Strict cookies (added in current branch) mitigate this for cross-site POST from top-level navigation, but do not protect against same-site scripted form submissions or embedded content.

**Impact**: An attacker who can trick a logged-in user could:

- Grant arbitrary permissions to an attacker-controlled agent
- Revoke existing consent grants
  Both without the user's knowledge or intent

**Suggested Remediation**: Implement CSRF token generation/validation (e.g., double-submit cookie pattern or stateful token stored in session), or add a CSRF-protected API pattern with anti-forgery tokens.

---

## F-002: No Rate Limiting on Token Issuance

**Severity**: MEDIUM  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-770 (Allocation of Resources Without Limits or Throttling)  
**Location**: src/routes/token.ts — POST /api/token

**Description**: POST /api/token has no rate limiting. An agent with a valid token can request an unlimited number of GitHub Installation Tokens, potentially exhausting GitHub API rate limits or causing unexpected billing charges.

**Impact**:

- GitHub API rate limit exhaustion for the GitHub App installation
- Resource waste (each token request makes multiple GitHub API calls: JWT signing, installation lookup, token creation)
- Potential auto-repo-creation spam: each token request with a non-existent repo triggers repository creation

**Suggested Remediation**: Implement per-agent rate limiting (e.g., sliding window in KV with per-agent_id counters). Consider a generous limit (e.g., 60 req/min per agent) to avoid breaking legitimate use.

---

## F-003: GitHub OAuth Scope 'repo' is Overly Broad

**Severity**: MEDIUM  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-272 (Least Privilege Violation)  
**Location**: src/routes/auth.ts — line scope: "repo"

**Description**: The GitHub OAuth authorization request uses scope: "repo" which grants full read/write access to ALL public and private repositories the user has access to. This is far broader than what deplodash needs — it only needs to verify the user's identity (read:user) and check admin status.

**Impact**: Any compromise of the session cookie or the deplodash Worker itself grants full GitHub repo access to the attacker. The OAuth token is also exposed via GET /api/user/token, which returns the full-power token to any code that can make a same-origin request.

**Suggested Remediation**: Reduce OAuth scope to the minimum: scope: "read:user" (verify identity). If admin check requires repo access, scope to specific repos.

---

## F-004: Unauthenticated Agent Token Revocation — No Authorization

**Severity**: LOW (design issue)  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-285 (Improper Authorization)  
**Location**: src/middleware/agent-auth.ts — revokeAgentToken()

**Description**: The
evokeAgentToken() function (used by admin routes) takes only kv and oken parameters with no further authorization check beyond what the caller (admin.ts) provides. The function itself has no authorization guard — it relies entirely on the caller. This is a defense-in-depth concern: if a future route calls
evokeAgentToken() without proper auth, any token can be revoked.

**Impact**: Low severity because the only production caller (dmin.ts) correctly checks admin RBAC. But the function signature and lack of internal guard makes it easy to misuse in future code changes.

**Suggested Remediation**: Add an explicit
equireAdmin parameter or extract admin check as middleware that's automatically applied, rather than inline checks in each handler.

---

## F-005: Sensitive Data in Log Output

**Severity**: LOW  
**Status**: NEW in current branch (added by commit ef...)  
**CWE**: CWE-532 (Insertion of Sensitive Information into Log File)  
**Location**: src/routes/consent.tsx — console.log(\REVOKE: repo=...\)

**Description**: The revoke handler logs the repo name and scope list to stdout via console.log. While scopes are not secrets, repo names could reveal non-public information about which repos a user is working with. Cloudflare Workers logs are not encrypted at rest by default.

**Impact**: Low — repo names and scope identifiers are typically not secret. But this is unnecessary data exposure that violates data minimization.

**Suggested Remediation**: Remove the console.log, or gate it behind a DEBUG flag, or restrict it to a structured logging framework with appropriate controls.

---

## F-006: Missing Content-Type Validation on POST /api/token

**Severity**: LOW  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-20 (Improper Input Validation)  
**Location**: src/routes/token.ts

**Description**: POST /api/token does not validate the Content-Type header. While hono-openapi's validator('json') will reject non-JSON bodies, the server still processes the request and returns a 400-level error. This is a minor defense-in-depth gap — not exploitable but not ideal.

**Impact**: Very low. The JSON validator catches malformed bodies. Only potential issue is if a different Content-Type causes unexpected behavior in Cloudflare Workers' request processing.

**Suggested Remediation**: Add Content-Type: application/json header validation for JSON endpoints.

---

## F-007: No Agent-Scoped Rate on Admin Endpoints

**Severity**: LOW  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-770 (Allocation of Resources Without Limits)  
**Location**: src/routes/admin.ts

**Description**: The admin routes (list, revoke) have no rate limiting. While access is restricted to GITHUB_ADMIN_USERS, there's no protection against an admin user making excessive calls. The listAgentTokens() endpoint scans the entire KV namespace, which could be expensive and slow.

**Impact**: Low — only admin users can access these endpoints. But if an admin account is compromised or abused, this could impact performance.

**Suggested Remediation**: Add rate limiting for admin endpoints, especially list operations.

---

## F-008: listAgentTokens Exposes Internal KV Key Names

**Severity**: LOW  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-200 (Information Exposure)  
**Location**: src/middleware/agent-auth.ts — listAgentTokens()

**Description**: While the admin API at src/routes/admin.ts maps tokens to remove the raw token value from the response, the internal function listAgentTokens() returns the raw KV key suffix as oken in the result tuples. This is correct behavior since the token IS the key, but if this function were reused in a different context, the raw token values could be leaked.

**Impact**: Low — current usage strips the token before returning. Defense-in-depth concern.

**Suggested Remediation**: Keep as-is. The admin router correctly filters out the token from the JSON response.

---

## F-009: Agent Token Brute Force — No Rate Limiting on Auth

**Severity**: MEDIUM  
**Status**: Not fixed — present in both main and current branch  
**CWE**: CWE-307 (Improper Restriction of Excessive Authentication Attempts)  
**Location**: src/middleware/agent-auth.ts — agentAuthMiddleware()

**Description**: The Bearer token authentication has no rate limiting. An attacker can try unlimited token values against POST /api/token with no lockout or throttling. Agent tokens are opaque (unknown format), but if a token is leaked or brute-forced, there's no exponential backoff.

**Impact**: Medium — agent tokens are high-entropy opaque strings, so brute force is infeasible. But no lockout means a leaked token can be used indefinitely until manually revoked.

**Suggested Remediation**: Add per-IP rate limiting on the auth endpoint. Add token-level anomaly detection (e.g., alert on sudden burst of 401s from same IP).

---

## F-010: ensureRepoExists Error Leak

**Severity**: LOW  
**Status**: ALREADY DOCUMENTED in modified AGENTS.md  
**CWE**: CWE-209 (Information Exposure Through an Error Message)  
**Location**: src/github-app.ts — ensureRepoExists(), src/routes/token.ts

**Description**: When repo creation fails, the GitHub API response body (first 200-500 chars) is included in the error thrown by nsureRepoExists(). The token route catch handler returns this message to the calling agent verbatim. This could leak internal GitHub API details, repo information, or API surface details.

**Impact**: Low — the error is returned only to authenticated agents, not unauthenticated users. But the content is GitHub API response text which might include unexpected details.

**Suggested Remediation**: Sanitize the error message to return only HTTP status code, removing response body from the agent-facing error.

---

## F-011: COMPOUND_SCOPES and Admin Scope Bypass Validation Gap

**Severity**: MEDIUM  
**Status**: NEW in current branch  
**CWE**: CWE-20 (Improper Input Validation)  
**Location**: src/types.ts — COMPOUND_SCOPES definition, src/routes/consent.tsx — scope validation

**Description**: The consent route validates scopes against SCOPE_LABELS + COMPOUND_SCOPES. However, the compound scopes like "admin" map to multiple GitHub permissions via LEGACY_PRESETS in github-app.ts. A user could approve the compound scope "admin" (which includes administration:write), but the UI displays it as a single checkbox. There's no warning shown to the user that "admin" includes destructive permissions.

**Impact**: Medium — users approving a compound scope like "admin" may not understand it grants administration:write (repo deletion/renaming). The scope system design makes this somewhat intentional, but it's a UX vulnerability.

**Suggested Remediation**: Show expanded permissions in the UI when a compound scope is selected, or split compound scopes into individual checkboxes on the consent page.

---

## F-012: Admin 'agent_id' Binding on Consent Revoke — Potentially Insufficient

**Severity**: LOW  
**Status**: NEW in current branch  
**CWE**: CWE-863 (Incorrect Authorization)  
**Location**: src/routes/consent.tsx — POST /auth/revoke

**Description**: The revoke handler accepts gent_id from the form body but doesn't validate that the authenticated user is authorized to revoke for that agent. The
evokeConsent() function deletes both the agent-scoped key AND the legacy key, which means a user could potentially revoke another agent's consent if they know the repo+scopes combination.

**Impact**: Low — the user needs to know the exact repo+scopes to construct the revoke request. And the consent they're revoking is technically theirs to manage (they granted it). But the agent_id binding isn't enforced here.

**Suggested Remediation**: Ensure the agent_id from the form matches the agent_id stored in the consent record being revoked. Consider requiring the agent_id to match what was originally granted.
