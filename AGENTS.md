# Deplodash — Deploy Key Dashboard + GitHub App Token Service

## Architecture

- **Runtime**: Deno Deploy (Hono SSR)
- **Auth**: GitHub OAuth (Authorization Code + PKCE) — 유저 로그인
- **Agent Auth**: Long-lived bearer token (Deno KV) — agent ↔ server
- **GitHub Token**: GitHub App Installation Token (scoped, 1h expiry)
- **Session**: Stateless, AES-GCM encrypted cookie (30일)
- **DB**: Deno KV (agent tokens, user consent, GitHub token cache)
- **Deploy**: CI/CD — main 브랜치 push → Deno Deploy 자동 배포

## v2 — GitHub App Token Flow

Agent가 deploy key 대신 GitHub App Installation Token으로 git push를 수행.

```
Agent                    Deplodash                          GitHub
 │                         │                                  │
 ├─ POST /api/token ──────►                                  │
 │  {repo, scopes}        │                                  │
 │  Auth: Bearer <agent>  ├── Deno KV: 컨펌 있음?             │
 │                        │  → 없으면                          │
 │◄─ {status:"needs_cons",│                                  │
 │    url:"/auth/consent"}│                                  │
 │                        │                                  │
 │ ── 유저 컨펌 ────────► │──>.pem → JWT ───────────────────►│
 │                        │◄── installation_token ──────────┤
 │                        ├── Deno KV: 캐싱                  │
 │◄─ {token, expires_at}  │                                  │
 │                        │                                  │
 ├─ git push (https) ─────┼────────────────────────────────►│
```

## v2 Endpoints (new)

| Path | Method | Auth | Description |
|------|--------|------|-------------|
| `POST /api/token` | POST | Agent token | GitHub installation token 요청/발급 |
| `GET /auth/consent` | GET | OAuth | 유저 컨펌 페이지 |
| `POST /api/token/confirm` | POST | OAuth | 컨펌 핸들러 |
| `GET /llms.txt` | GET | - | Agent용 API 가이드 |

기존 deploy key 엔드포인트는 유지 (deprecated).

## Module Structure

```
deno.json
main.ts          ← entry (routes, server startup)
src/
  types.ts       ← Repo, DeployKey, RepoStatus, AppState
  errors.ts      ← TokenExpiredError
  crypto.ts      ← AES-GCM encrypt/decrypt, PKCE
  github.ts      ← GitHubClient (OAuth + API)
  helpers.ts     ← normalizeKey, escapeHtml, parseCookies, cookieSet, parseRepo
  html.ts        ← DaisyUI HTML templates
  ─── v2 new modules ───
  agent-auth.ts  ← Agent bearer token auth middleware
  github-app.ts  ← GitHub App JWT + Installation Token
  token-service.ts ← Deno KV, consent, token cache
  consent-ui.ts  ← /auth/consent page
  llms.ts        ← /llms.txt
```

## Deno KV Schema

```ts
// Agent authentication tokens
["agent_tokens", tokenString] → {
  agent_id: string,
  label: string,
  created_at: Date,
}

// User consent records
["user_consent", userId: number, repo: string, scopesHash: string] → {
  granted_at: Date,
}

// GitHub installation token cache
["gh_token", repo: string, scopesHash: string] → {
  token: string,
  expires_at: Date,
}
```

## Environment Variables (new)

- `GITHUB_APP_ID` — GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` — GitHub App PEM private key
- `GITHUB_INSTALLATION_ID` — GitHub App installation ID
- `AGENT_TOKEN` — Pre-configured agent bearer token (optional)
