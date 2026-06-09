# Deplodash — Deploy Key Dashboard

GitHub OAuth로 로그인해서 모든 레포의 deploy key를 대시보드에서 관리하는 웹앱.

## Architecture

- **Runtime**: Deno Deploy (Hono SSR)
- **Auth**: GitHub OAuth (Authorization Code + PKCE)
- **Session**: Stateless, AES-GCM encrypted cookie (30일)
- **Deploy**: CI/CD — main 브랜치 push → Deno Deploy 자동 배포

## Usage (User)

1. 대시보드 접속 → GitHub OAuth 로그인
2. `/setup`에서 SSH public key 등록 (최초 1회, 쿠키 저장)
3. 대시보드에서 전체 레포의 deploy key 상태 확인 및 추가/제거

## Start Links

한 번에 등록 페이지로 바로가는 링크:

```
/register?repo=owner%2Frepo&perm=RW&key_name=nanobot-{label}
```

- `repo`: `owner/repo` URL 인코딩 필수
- `perm`: `RW` 또는 `RO`
- `key_name`: key 식별자, 기본값 `nanobot`
- SSH key는 쿠키에서 자동 로드 (별도 전달 불필요)

## Endpoints

| Path | Method | Auth | Description |
|------|--------|------|-------------|
| `/` | GET | OAuth | 대시보드 (모든 레포 목록 + key 상태) |
| `/setup` | GET/POST | OAuth | SSH public key 등록 |
| `/register` | GET | - | 바로가기 링크용 등록 페이지 |
| `/api/register` | POST | OAuth | deploy key 등록 |
| `/api/delete` | POST | OAuth | deploy key 제거 |
| `/api/create-repo` | POST | OAuth | 새 레포 생성 |
| `/auth/github` | GET | - | OAuth 로그인 |
| `/callback` | GET | - | OAuth 콜백 |
| `/logout` | GET | - | 로그아웃 |

## Module Structure

```
deno.json
main.ts          ← entry (routes, server startup, tests)
src/
  types.ts       ← Repo, DeployKey, RepoStatus, AppState
  errors.ts      ← TokenExpiredError
  crypto.ts      ← AES-GCM encrypt/decrypt, PKCE
  github.ts      ← GitHubClient (OAuth + API)
  helpers.ts     ← normalizeKey, escapeHtml, parseCookies, cookieSet, parseRepo
  html.ts        ← DaisyUI HTML templates
```
