# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.
All agents, such as Claude Code, should keep `**/AGENTS.md` in mind.

## Project

**Deplodash** — A GitHub Deploy Key Dashboard built with Hono on Cloudflare Workers.
Migrated from a Deno Deploy app (`legacy/`).

Manage SSH deploy keys across all your GitHub repositories: register, remove, and check status of deploy keys in bulk.

## Architecture

```
src/
  index.ts           — App entry: CORS, route mounting, OpenAPI/Scalar docs
  route.ts           — Root router: composes all sub-routers with session middleware
  types.ts           — Env bindings, GitHub API types, AppState, v2 types
  errors.ts          — Custom error classes (TokenExpiredError)
  crypto.ts          — AES-256-GCM encrypt/decrypt, PKCE challenge, base64url
  helpers.ts         — Pure utilities (normalizeKey, escapeHtml, parseRepo, parsePerm, isSafeRedirect, hashScopes)
  github.ts          — GitHub API client (OAuth user lookup, repos, deploy keys)
  github-app.ts      — GitHub App JWT signing + Installation Token issuance (v2)
  token-service.ts   — Cloudflare KV consent management + token caching (v2)
  html.ts            — SSR HTML templates (DaisyUI + Lucide icons)
  middleware.ts      — Session cookie decryption, auth guard
  middleware/
    agent-auth.ts    — Bearer token auth middleware for agents (v2)
  routes/
    auth.ts          — GET /auth/github (PKCE OAuth start)
    oauth.ts         — GET /callback, GET /logout
    pages.ts         — GET /, GET /setup, POST /setup, GET /register
    api.ts           — POST /api/register, POST /api/delete, POST /api/create-repo
    consent.ts       — GET/POST /auth/consent — user consent page for agents (v2)
    token.ts         — POST /api/token — agent token endpoint (v2)
    llms.ts          — GET /llms.txt — agent documentation (v2)
  utils/
    cors.ts          — CORS middleware
tests/               — Vitest test suite
  helpers.ts         — Shared test utilities (mockKVNamespace)
```

## Environment Variables

Set in `.dev.vars` for local dev, or via `wrangler secret put` / Cloudflare dashboard for production:

### Required (v1 — Deploy Key Dashboard)

| Variable               | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | GitHub OAuth App client ID                                 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret                             |
| `CALLBACK_URL`         | OAuth callback URL (e.g. `http://localhost:5178/callback`) |
| `ENCRYPTION_SECRET`    | Encryption key for session/SSH cookies                     |
| `KV`                   | Cloudflare KV namespace (binding, not secret)              |

### Optional (v1 — dev/testing)

| Variable       | Description                     |
| -------------- | ------------------------------- |
| `GITHUB_TOKEN` | Direct GitHub PAT (skips OAuth) |

### Optional (v2 — GitHub App Token Service)

| Variable                 | Description                             |
| ------------------------ | --------------------------------------- |
| `GITHUB_APP_ID`          | GitHub App ID                           |
| `GITHUB_APP_PRIVATE_KEY` | PEM-encoded RSA private key for the App |
| `GITHUB_INSTALLATION_ID` | GitHub App Installation ID              |

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

See `docs/rules/` for TypeScript, testing, and tooling guidelines.

## TypeScript Configuration

- Path alias: `@/*` maps to `src/*` (configured in `tsconfig.base.json`)

## Package Manager

This project uses pnpm.

## Cloudflare Workers

This project uses `wrangler` for Cloudflare Workers development and deployment.
Configuration is in `wrangler.jsonc`.
