# Worker Threat Model — Round 01, Worker 01

## Target: deplodash / C:\Users\PC\Projects\VSCode\deplodash (main vs. dev/fix-consent-user-and-scope-validation)

## Attacker Profiles

### A1: External Unauthenticated Attacker

- No valid session cookie, no valid agent token
- Can reach: GET /llms.txt, GET /auth/github
- Cannot reach: POST /api/token, any auth-guarded route

### A2: External Attacker with Valid Agent Token

- Has a valid pre-provisioned agent token
- Can reach: POST /api/token with scoped token requests
- Can trigger: auto-repo-creation, token issuance for any repo the GitHub App can reach
- Cannot reach: consent flow (requires user OAuth)

### A3: Authenticated User

- Has valid GitHub OAuth session
- Can reach: consent page, revoke endpoints, admin endpoints (if admin)
- Can approve/deny scopes for agent requests

### A4: External Web Attacker (network-level)

- Can observe HTTP traffic (non-HTTPS dev only)
- Cannot: decrypt TLS in production

### A5: CSRF Attacker

- Can trick authenticated user into submitting a form to deplodash

## Trust Boundaries

- **TB1**: Between external clients and deplodash Worker
- **TB2**: Between deplodash Worker and GitHub API
- **TB3**: Between deplodash Worker and Cloudflare KV
- **TB4**: Between deplodash Worker and the user's browser (cookie/session boundary)
- **TB5**: Between deplodash Worker and agent (Bearer token boundary)

## Privileged Surfaces

- **PS1**: POST /api/token — Issues GitHub Installation Tokens (requires agent auth)
- **PS2**: POST /auth/consent — Records permission grants (requires user auth)
- **PS3**: POST /auth/revoke — Revokes permissions (requires user auth)
- **PS4**: GET /api/admin/agent/list — Lists agent tokens (requires admin auth)
- **PS5**: POST /api/admin/agent/revoke — Revokes agent tokens (requires admin auth)
- **PS6**: KV namespace — Stores consent records, cached tokens, agent tokens
- **PS7**: GitHub App private key — Signs JWTs for installation token requests

## Key Security Properties to Evaluate

1. Consent integrity: can approved scopes be tampered with?
2. Token isolation: can Agent A use Agent B's consent?
3. Session security: are user sessions protected from CSRF, replay, eavesdropping?
4. Rate limiting: can endpoints be abused?
5. Error handling: do errors leak sensitive information?
6. Input validation: are all inputs properly validated and sanitized?
