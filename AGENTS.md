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
  index.ts       — App entry: CORS, route mounting, OpenAPI/Scalar docs
  route.ts       — Root router: composes all sub-routers with session middleware
  types.ts       — Env bindings, GitHub API types, AppState
  errors.ts      — Custom error classes (TokenExpiredError)
  crypto.ts      — AES-256-GCM encrypt/decrypt, PKCE challenge, base64url
  helpers.ts     — Pure utilities (normalizeKey, escapeHtml, parseRepo, parsePerm, isSafeRedirect)
  github.ts      — GitHub API client (list repos, deploy keys, create/delete)
  html.ts        — SSR HTML templates (DaisyUI + Lucide icons)
  middleware.ts   — Session cookie decryption, auth guard
  routes/
    auth.ts      — GET /auth/github (PKCE OAuth start)
    oauth.ts     — GET /callback, GET /logout
    pages.ts     — GET /, GET /setup, POST /setup, GET /register
    api.ts       — POST /api/register, POST /api/delete, POST /api/create-repo
  utils/
    cors.ts      — CORS middleware
legacy/          — Original Deno Deploy app (for reference)
tests/           — Vitest test suite
```

## Environment Variables (required)

Set in `.dev.vars` for local dev, or via `wrangler secret put` / Cloudflare dashboard for production:

| Variable               | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | GitHub OAuth App client ID                                 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret                             |
| `CALLBACK_URL`         | OAuth callback URL (e.g. `http://localhost:5178/callback`) |
| `ENCRYPTION_SECRET`    | Encryption key for session/SSH cookies                     |
| `GITHUB_TOKEN`         | (Optional) Direct PAT for dev/testing                      |

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
