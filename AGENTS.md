# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.
All agents, such as Claude Code, should keep `**/AGENTS.md` in mind.

## Project

**Deplodash** — A GitHub App Token Service built with Hono on Cloudflare Workers.

Issue scoped GitHub Installation Tokens to AI agents for git push and API access.
Supports auto-repo-creation: when an agent requests a token for a non-existent
repository, deplodash creates it automatically.

## Architecture

```
src/
  index.ts           — App entry: CORS, route mounting, OpenAPI/Scalar docs
  route.ts           — Root router: composes all sub-routers with session middleware
  types.ts           — Env bindings, GitHub API types, v2 types
  errors.ts          — Custom error classes (TokenExpiredError)
  crypto.ts          — AES-256-GCM encrypt/decrypt, PKCE challenge, base64url
  helpers.ts         — Pure utilities (escapeHtml, parseRepo, isSafeRedirect, hashScopes)
  github.ts          — GitHub OAuth API client (user lookup, repos, OAuth exchange)
  github-app.ts      — GitHub App JWT signing + dynamic Installation Token issuance + repo creation
  token-service.ts   — Cloudflare KV consent management + token caching + list/revoke
  middleware.tsx     — Session cookie decryption, auth guard
  html.ts            — (deprecated) migrated to TSX views
  views/             — Hono JSX (TSX) page components
    Layout.tsx       — Base HTML layout + renderPage() helper
    LoginPage.tsx    — Login page with GitHub OAuth button
    HomePage.tsx     — Dashboard with consent list + revoke buttons
    ConsentPage.tsx  — Agent consent approval form
    Navbar.tsx       — Top navigation bar
    Sidebar.tsx      — Side navigation drawer
    index.ts         — Barrel exports
  middleware/
    agent-auth.ts    — Bearer token auth middleware for agents
  routes/
    auth.ts          — GET /auth/github (PKCE OAuth start)
    oauth.ts         — GET /callback, GET /logout
    pages.tsx        — GET / (home/dashboard with consent list)
    api.ts           — (empty) legacy v1 API placeholder
    consent.tsx      — GET/POST /auth/consent + POST /auth/revoke
    token.ts         — POST /api/token — agent token endpoint (with auto-create)
    llms.ts          — GET /llms.txt — agent documentation
  utils/
    cors.ts          — CORS middleware
tests/               — Vitest test suite (178 tests, 96%+ coverage)
  helpers.ts         — Shared test utilities (strictMock)
  unit/
    errors.test.ts   — TokenExpiredError tests
    views.test.tsx   — TSX component rendering tests
    github.test.ts   — GitHubClient fetch mock tests
    agent-auth.test.ts — Agent token auth tests
    oauth.test.ts    — OAuth flow tests
    github-app.test.ts — Dynamic installation resolution tests
    token-service.test.ts — Consent + cache + list + revoke tests
    routes-v2.test.ts — Full route integration tests
```

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

| Variable       | Description                     |
| -------------- | ------------------------------- |
| `GITHUB_TOKEN` | Direct GitHub PAT (skips OAuth) |

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
- **`listConsents()` pagination** — `TokenService.listConsents()` in `token-service.ts` does not handle `kv.list()` cursor pagination. At most 1000 consent records returned.
- **`github-app.ts` `resolveInstallationId`** — Does not cache installation IDs across requests. Each request to a different owner triggers a fresh GitHub API call. Consider adding KV-based caching with TTL.
- **`api.ts`** — Empty legacy v1 API placeholder. Consider removing if not needed.
