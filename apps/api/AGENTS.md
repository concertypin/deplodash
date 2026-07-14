# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.
All agents, such as Claude Code, should keep `**/AGENTS.md` in mind.

## Project

**Deplodash** — A GitHub App Token Service built with Hono on Cloudflare Workers.

Issue scoped GitHub Installation Tokens to AI agents for git push and API access.
Supports auto-repo-creation: when an agent requests a token for a non-existent
repository, deplodash creates it automatically.

## Architecture

- **Monorepo** (pnpm workspace) with `apps/api` and `apps/web`
- **`apps/api/src/`** — Backend application (Hono on Cloudflare Workers)
    - **`routes/`** — Route handlers (token, consent, auth, oauth, llms, admin, user)
    - **`middleware/`** — Session cookie auth, Bearer token auth for agents
    - Core modules: `crypto.ts`, `github-app.ts`, `github.ts`, `token/service.ts`, `helpers.ts`, `types.ts`, `errors.ts`
- **`apps/web/src/`** — Frontend application (Svelte 5 SPA with Hono RPC)
    - **`lib/api.ts`** — Hono RPC client with full type inference from backend
    - **`lib/HomePage.svelte`** — Dashboard / Login page
    - **`lib/ConsentPage.svelte`** — OAuth consent grant page
    - **`App.svelte`** — Simple rune-based SPA router for `/` and `/auth/consent`
- **`tests/`** — Vitest test suite (245 tests, 90%+ coverage)

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
# Run both API + frontend dev servers with one command (root)
pnpm dev

# Start API backend dev server only (port 5173)
cd apps/api && pnpm dev

# Start Svelte frontend dev server only (port 5174, proxies API)
cd apps/web && pnpm dev

# Build Worker for production (from root or api)
pnpm build:api
# Build frontend for production
pnpm build:web

# Run backend tests
pnpm test
cd apps/api && pnpm test

# Format/Lint backend
cd apps/api && pnpm format && pnpm lint
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

- **KV listAgentTokens pagination** — `src/middleware/agent-auth.ts` `listAgentTokens()` does not handle `kv.list()` cursor-based pagination (KV returns at most 1000 keys per page). Add pagination loop for admin tools.
- **Agent token management** — No admin UI or API to register/revoke agent tokens. Currently must be done via direct KV writes or wrangler.
- **`listConsents()` pagination** — `TokenService.listConsents()` in `token-service.ts` batches KV gets (50 at a time) for performance but still does not handle `kv.list()` cursor-based pagination. At most 1000 consent records returned per page.
- **`github-app.ts` `resolveInstallationId`** — Does not cache installation IDs across requests. Each request to a different owner triggers a fresh GitHub API call. Consider adding KV-based caching with TTL.
- **`api.ts`** — Empty legacy v1 API placeholder. Consider removing if not needed.

Cloudflare `ratelimit` binding added (`TOKEN_RATE_LIMITER`, 100 req/60s per agent_id). 429 on overflow.

### M-003 — GitHub API Error Leak

All error throws in `github-app.ts` strip API response bodies. `token.ts` catch uses `KNOWN_SAFE_ERRORS` allowlist.
