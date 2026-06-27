# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.
All agents, such as Claude Code, should keep `**/AGENTS.md` in mind.

## Project

**Deplodash** — A GitHub App Token Service built with Hono on Cloudflare Workers.

Issue scoped GitHub Installation Tokens to AI agents for git push and API access.
Supports auto-repo-creation: when an agent requests a token for a non-existent
repository, deplodash creates it automatically.

## Architecture

- **`src/`** — Application source (Hono on Cloudflare Workers)
    - **`routes/`** — Route handlers (token, consent, auth, oauth, pages, llms)
    - **`views/`** — Hono JSX (TSX) page components (Layout, LoginPage, HomePage, ConsentPage, Navbar, Sidebar)
    - **`middleware/`** — Session cookie auth, Bearer token auth for agents
    - Core modules: `crypto.ts`, `github-app.ts`, `github.ts`, `token-service.ts`, `helpers.ts`, `types.ts`, `errors.ts`
    - Utilities: `cors.ts`
- **`tests/`** — Vitest test suite (211 tests, 87%+ coverage)

## Environment Variables

Set in `.dev.vars` for local dev, or via `wrangler secret put` / Cloudflare dashboard for production:

### Required

| Variable                 | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `GITHUB_CLIENT_ID`       | GitHub OAuth App client ID (for consent page auth)         |
| `GITHUB_CLIENT_SECRET`   | GitHub OAuth App client secret                             |
| `CALLBACK_URL`           | OAuth callback URL (e.g. `http://localhost:5178/callback`) |
| `ENCRYPTION_SECRET`      | Encryption key for session cookies                         |
| `KV`                     | Cloudflare KV namespace (binding, not secret)              |
| `GITHUB_APP_ID`          | GitHub App ID                                              |
| `GITHUB_APP_PRIVATE_KEY` | PEM-encoded RSA private key for the GitHub App             |

### Optional (dev/testing)

| Variable             | Description                             |
| -------------------- | --------------------------------------- |
| `GITHUB_TOKEN`       | Direct GitHub PAT (skips OAuth)         |
| `GITHUB_ADMIN_USERS` | Comma-separated list of admin usernames |

### Cloudflare Bindings

| Binding              | Description                                      |
| -------------------- | ------------------------------------------------ |
| `KV`                 | Cloudflare KV namespace (consent, tokens, cache) |
| `TOKEN_RATE_LIMITER` | Rate Limiting for /api/token (100 req/60s)       |

## Development Commands

```bash
# Start development server (wrangler)
pnpm dev

# Build for production (Cloudflare Workers)
pnpm build

# Format code
pnpm format

# Lint code
pnpm lint

# Run tests
pnpm test
```

## Coding Standards

If you can't access the project's convention, such as hono, typescript, typescript-schema, ask user for adding MCP server.
MCP Server:

- Endpoint: https://conventions.aieuroka.workers.dev/mcp (for most clients), https://conventions.aieuroka.workers.dev/with-tool/mcp (for GitHub Copilot, which doesn't support resource retrieval)
- Streamable HTTP, without authentication

## TypeScript Configuration

- Path alias: `@/*` maps to `src/*` (configured in `tsconfig.base.json`)

## Package Manager

This project uses pnpm.

## Cloudflare Workers

This project uses `wrangler` for Cloudflare Workers development and deployment.
Configuration is in `wrangler.jsonc`.

## Known Issues / TODOs

- **CDN dependencies** — Views (TSX components in `src/views/`) load DaisyUI, Tailwind, and Lucide from external CDNs with `unsafe-inline` script-src. Should be bundled/inlined before production.
- **KV listAgentTokens pagination** — `src/middleware/agent-auth.ts` `listAgentTokens()` does not handle `kv.list()` cursor-based pagination (KV returns at most 1000 keys per page). Add pagination loop for admin tools.
- **OpenAPI spec incomplete** — `POST /api/token`, `POST /auth/consent` and auth endpoints lack proper OpenAPI response schemas. See `TODO.md`.
- **Agent token management** — No admin UI or API to register/revoke agent tokens. Currently must be done via direct KV writes or wrangler.
- **`listConsents()` pagination** — `TokenService.listConsents()` in `token-service.ts` batches KV gets (50 at a time) for performance but still does not handle `kv.list()` cursor-based pagination. At most 1000 consent records returned per page.
- **`github-app.ts` `resolveInstallationId`** — Does not cache installation IDs across requests. Each request to a different owner triggers a fresh GitHub API call. Consider adding KV-based caching with TTL.
- **`api.ts`** — Empty legacy v1 API placeholder. Consider removing if not needed.

## Resolved Issues

### D-001 — Cross-user Consent Exposure

`listConsents()` now accepts `grantedBy?` filter; `revokeConsent()` has `caller?` ownership check. Dashboard scoped to current user.

### F-DIS-004 — Token API Rate Limiting

Cloudflare `ratelimit` binding added (`TOKEN_RATE_LIMITER`, 100 req/60s per agent_id). 429 on overflow.

### M-003 — GitHub API Error Leak

All error throws in `github-app.ts` strip API response bodies. `token.ts` catch uses `KNOWN_SAFE_ERRORS` allowlist.
