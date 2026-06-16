# 🤖 Deplodash — GitHub App Token Service

Issue scoped GitHub Installation Tokens to AI agents for git push and API access.
Built with Hono on Cloudflare Workers.

## Features

- **Agent token API** — AI agents request scoped installation tokens via `POST /api/token`
- **Auto-repo-creation** — When an agent requests a token for a non-existent repo, deplodash creates it automatically
- **Consent management** — Repository owners approve agent access via a web consent page
- **Token caching** — Installation tokens are cached in KV to minimize GitHub API calls
- **OAuth login** — PKCE-based GitHub OAuth for user authentication (consent page only)
- **Scoped permissions** — `contents:read`, `contents:write`, `workflows:write`, `admin`
- **OpenAPI docs** — Auto-generated API documentation at `/docs`

## Quick Start

```sh
pnpm install

# Copy and fill in your credentials
cp .dev.vars.example .dev.vars

pnpm dev     # → http://localhost:5178
pnpm test    # 48+ tests
pnpm build   # → dist/
```

## Environment Variables

| Variable                 | Required | Description                                                     |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`       | ✅       | GitHub OAuth App client ID (for consent page auth)              |
| `GITHUB_CLIENT_SECRET`   | ✅       | GitHub OAuth App client secret                                  |
| `CALLBACK_URL`           | ✅       | Full OAuth callback URL (dev: `http://localhost:5178/callback`) |
| `ENCRYPTION_SECRET`      | ✅       | Encryption key for session cookies                              |
| `KV`                     | ✅       | Cloudflare KV namespace binding                                 |
| `GITHUB_APP_ID`          | ✅       | GitHub App ID                                                   |
| `GITHUB_APP_PRIVATE_KEY` | ✅       | PEM-encoded RSA private key for the GitHub App                  |
| `GITHUB_INSTALLATION_ID` | ✅       | GitHub App Installation ID                                      |
| `GITHUB_TOKEN`           | ❌       | Direct PAT — skips OAuth (dev/testing only)                     |

## How It Works

```
┌──────────┐     POST /api/token      ┌────────────┐     GitHub API    ┌──────────┐
│ AI Agent │  ────────────────────────▶│ Deplodash  │──────────────────▶│  GitHub  │
│          │◀─────────────────────────│ (Worker)   │◀──────────────────│          │
└──────────┘   Installation Token      └────────────┘                  └──────────┘
                     ▲                        │
                     │            ┌───────────┴──────────┐
                     │            │  Cloudflare KV        │
                     │            │  • Agent tokens       │
                     │            │  • Consent records    │
                     │            │  • Token cache        │
                     │            └───────────────────────┘
                     │
                ┌────┴────┐
                │  User   │  (approves via /auth/consent)
                └─────────┘
```

1. **Agent** sends `POST /api/token` with a pre-provisioned Bearer token, repo, and scope
2. **Deplodash** checks if the repo exists → creates it if missing
3. **Deplodash** checks consent in KV → if not yet approved, returns a consent URL
4. **User** visits the consent URL, logs in via OAuth, and approves access
5. **Agent** retries, gets a scoped GitHub Installation Token
6. **Agent** uses the token for `git push` or GitHub API calls

## API

### `POST /api/token` — Request an Installation Token

```json
// Request
{ "repo": "owner/repo", "scopes": ["contents:write"] }

// Response (200) — Token issued
{ "status": "ok", "token": "ghs_xxxxxxxxxxxx", "expires_at": "2026-06-14T20:00:00Z" }

// Response (202) — Consent required
{ "status": "needs_consent", "url": "https://.../auth/consent?repo=..." }
```

Available scopes: `contents:read`, `contents:write`, `workflows:write`, `admin`

## OAuth Setup

Only needed for the consent page authentication:

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
  github-app.ts  → GitHub App JWT signing + Installation Token issuance
  token-service.ts → KV consent management + token caching
  helpers.ts     → Utility functions
  html.ts        → SSR HTML templates (DaisyUI + Lucide icons)
  middleware.ts  → Session cookie decryption, auth guard
  middleware/
    agent-auth.ts → Bearer token auth middleware
  routes/
    token.ts     → POST /api/token (with auto-repo-creation)
    consent.ts   → GET/POST /auth/consent
    auth.ts      → GET /auth/github (PKCE OAuth start)
    oauth.ts     → GET /callback, GET /logout
    pages.ts     → GET / (home page)
    llms.ts      → GET /llms.txt
```

## Deploy

```sh
# Set secrets (one-time)
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put CALLBACK_URL
npx wrangler secret put ENCRYPTION_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_INSTALLATION_ID

# Update KV namespace ID in wrangler.jsonc, then deploy
npx wrangler deploy
```

## License

Apache-2.0, see [LICENSE](./LICENSE) for details.
