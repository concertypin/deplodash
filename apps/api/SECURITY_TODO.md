# Security TODO

실제로 고쳐야 할 보안 이슈들. AGENTS.md의 기술부채나 SECURITY_NOTE.md의 설계 결정과는 별도로 추적.

---

## ✅ P2 — D-001: 크로스유저 Consent 노출 + 무단 철회 (완료)

**수정 내용**:

- `listConsents(grantedBy?)`에 유저 필터 파라미터 추가 — `granted_by` 일치 레코드만 반환
- `revokeConsent()`에 `caller` 파라미터 추가 — 불일치시 `ConsentOwnershipError` throw
- `pages.tsx`에서 `listConsents(user.login)` 호출로 현재 유저의 consents만 표시
- `consent.tsx` POST `/revoke`에서 `c.get("client")`로 소유권 확인 후 revoke
- `errors.ts`에 `ConsentOwnershipError` 클래스 추가

---

## ✅ P3 — F-DIS-004: Token 발행 API Rate Limiting (완료)

**수정 내용**:

- Cloudflare 네이티브 `ratelimit` 바인딩 사용 (`TOKEN_RATE_LIMITER`, simple: 100 req/60s)
- `wrangler.jsonc`에 `ratelimits` 설정 추가
- `types.ts`에 `TOKEN_RATE_LIMITER?: RateLimit` 타입 추가 (optional — dev/test 대응)
- `token.ts`에서 agent_id 기준 rate limit 체크 — 초과시 429 응답
- `Env` 타입에서 optional 처리 (guard로 안전하게 fallback)

---

## ✅ P3 — M-003: GitHub API 에러 메시지 유출 (완료)

**수정 내용**:

- `github-app.ts` — 모든 에러 throw에서 GitHub API 응답 바디 제거, HTTP 상태 코드만 포함
    - `resolveInstallationId()`, `getInstallationToken()`, `ensureRepoExists()` 일괄 수정
- `token.ts` catch — safe error 패턴 매칭으로 알려진 에러만 통과, 나머지는 generic fallback
