# 🗝️ Deplodash — GitHub Deploy Key Dashboard

Manage SSH deploy keys across all your GitHub repositories in bulk. Built with Hono on Cloudflare Workers.

## Features

- **Bulk management** — See which repositories have your deploy key registered
- **OAuth login** — PKCE-based GitHub OAuth for secure authentication
- **SSR dashboard** — Server-side rendered UI with DaisyUI + Lucide icons
- **Read-only mode** — Fall back to a `GITHUB_TOKEN` env var for dev/testing
- **OpenAPI docs** — Auto-generated API documentation at `/docs`

## Quick Start

```sh
pnpm install

# Copy and fill in your GitHub OAuth credentials
cp .dev.vars.example .dev.vars

pnpm dev     # → http://localhost:5178
pnpm test    # 28 tests
pnpm build   # → dist/
```

## Environment Variables

| Variable               | Required | Description                                                       |
| ---------------------- | -------- | ----------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | ✅       | GitHub OAuth App client ID                                        |
| `GITHUB_CLIENT_SECRET` | ✅       | GitHub OAuth App client secret                                    |
| `CALLBACK_URL`         | ✅       | Full OAuth callback URL (local: `http://localhost:5178/callback`) |
| `ENCRYPTION_SECRET`    | ✅       | Encryption key for session/SSH cookies                            |
| `GITHUB_TOKEN`         | ❌       | Direct PAT — skips OAuth (dev/testing only)                       |

## OAuth Setup

1. **GitHub** → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Set **Authorization callback URL** to your app's `/callback`
    - Local: `http://localhost:5178/callback`
    - Production: `https://your-worker.workers.dev/callback`
3. Copy the Client ID and Client Secret to `.dev.vars`

## Architecture

```
src/
  index.ts       → CORS, route mounting, OpenAPI/Scalar docs
  route.ts       → Root router with session middleware
  crypto.ts      → AES-256-GCM encrypt/decrypt (PBKDF2 derived)
  github.ts      → GitHub REST API client
  html.ts        → SSR HTML templates (DaisyUI 4 + Lucide)
  routes/
    auth.ts      → /auth/github (PKCE OAuth start)
    oauth.ts     → /callback, /logout
    pages.ts     → /, /setup, /register
    api.ts       → /api/register, /api/delete, /api/create-repo
```

## API Docs

Auto-generated OpenAPI documentation is available at `/docs` (Scalar UI).

## License

Apache-2.0, see [LICENSE](./LICENSE) for details.
