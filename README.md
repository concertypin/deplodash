[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/concertypin/deplodash)

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
- **Rate limiting** — Per-agent rate limiting via Cloudflare's native ratelimit binding (100 req/60s)
- **Consent ownership** — Users see and manage only their own consents; cross-user revocation blocked
- **Error safety** — GitHub API error details are sanitized before returning to callers
- **OpenAPI docs** — Auto-generated API documentation at `/docs`

## Quick Start

```sh
pnpm install

# Copy and fill in your credentials
cp .dev.vars.example .dev.vars

pnpm dev     # → http://localhost:5178
pnpm test
pnpm build   # → dist/
```

## Environment Variables

| Variable                 | Required | Description                                                     |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`       | ✅       | GitHub OAuth App client ID (for consent page auth)              |
| `GITHUB_CLIENT_SECRET`   | ✅       | GitHub OAuth App client secret                                  |
| `CALLBACK_URL`           | ✅       | Full OAuth callback URL (dev: `http://localhost:5178/callback`) |
| `ENCRYPTION_SECRET`      | ✅       | Encryption key for session cookies                              |
| `GITHUB_APP_ID`          | ✅       | GitHub App ID                                                   |
| `GITHUB_APP_PRIVATE_KEY` | ✅       | PEM-encoded RSA private key for the GitHub App                  |
| `GITHUB_TOKEN`           | ❌       | Direct PAT — skips OAuth (dev/testing only)                     |
| `OIDC_ISSUER`            | ❌       | OIDC issuer origin; enables Google Cloud access (see below)     |
| `OIDC_SIGNING_KEY`       | ❌       | RSA PKCS#8 PEM (2048+ bits) that signs OIDC identity tokens     |
| `OIDC_ADDITIONAL_JWKS`   | ❌       | Extra RSA public keys published during signing key rotation     |

## How It Works

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant W as Deplodash (Worker)
    participant KV as Cloudflare KV
    participant User as User
    participant GH as GitHub API

    Agent->>W: POST /api/token<br/>(Bearer token, repo, scopes)
    W->>KV: Check consent
    alt No consent
        W-->>Agent: 202 needs_consent + URL
        User->>W: GET /auth/consent (approves)
        W->>KV: Store consent
        Agent->>W: POST /api/token (retry)
    end
    W->>GH: Create repo (if missing)<br/>Request installation token
    GH-->>W: Installation Token
    W->>KV: Cache token
    W-->>Agent: 200 { token, expires_at }
    Agent->>GH: git push / API calls
```

1. **Agent** sends `POST /api/token` with a pre-provisioned Bearer token, repo, and scope
2. **Deplodash** checks consent in KV → if not yet approved, returns a consent URL
3. **Agent** can optionally wait for consent using the Long Polling endpoint `QUERY /api/wait`
4. **User** visits the consent URL, logs in via OAuth, and approves access
5. **Agent** gets notified (or retries `POST /api/token`), gets a scoped GitHub Installation Token (repo is auto-created if missing)
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

### `POST /api/oidc/token` — Request an OIDC Identity Token

```json
// Request
{ "audience": "https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/deplodash" }

// Response (200) — 10-minute ID token for Workload Identity Federation
{ "status": "ok", "id_token": "eyJ...", "token_type": "urn:ietf:params:oauth:token-type:id_token", "expires_at": "...", "subject": "agent:<uid>" }

// Response (202) — the agent's owner must approve this audience
{ "status": "needs_consent", "url": "https://.../auth/oidc-consent?...", "subject": "agent:<uid>" }
```

## Google Cloud (Workload Identity Federation)

Deplodash is an OIDC issuer, so agents can get Google Cloud credentials without a service account key. Every agent token issued from the dashboard has a stable subject `agent:<uid>`, shown under its ID on the dashboard. The uid belongs to the agent token: revoking the token retires the subject for good, even if an agent with the same ID is created again. Agent tokens created before OIDC support (no subject on the dashboard) get `409` from the OIDC endpoints; issue a new token to use them.

1. Create a pool and an OIDC provider that trusts Deplodash. **Always set the attribute condition on `sub`**: the issuer is shared by every Deplodash user, so without it any Deplodash agent could use your provider. Trust only `sub` (`agent:<uid>`). `agent_id` is a name anyone can pick (two users may both have an agent called `asdf`), and `owner_github_id` is informational, so never base IAM bindings or conditions on either.

   ```sh
   gcloud iam workload-identity-pools create agents-pool --location=global
   gcloud iam workload-identity-pools providers create-oidc deplodash \
     --location=global --workload-identity-pool=agents-pool \
     --issuer-uri=https://deplodash.euroka.moe \
     --attribute-mapping="google.subject=assertion.sub" \
     --attribute-condition="assertion.sub == 'agent:<uid>'"
   ```

2. Grant access to the agent's principal, either directly on resources or by letting it impersonate a service account:

   ```sh
   gcloud iam service-accounts add-iam-policy-binding <sa-email> \
     --role=roles/iam.workloadIdentityUser \
     --member="principal://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/agents-pool/subject/agent:<uid>"
   ```

3. The agent calls `POST /api/oidc/token` with the provider as `audience`. The first request returns a consent URL; approve it while signed in as the agent's owner (only the owner can). Approvals are listed under **Cloud Access (OIDC)** on the dashboard and can be revoked there. Revoking stops new identity tokens, after up to about a minute while other Cloudflare locations still serve the cached consent. Tokens already issued stay valid until they expire (10 minutes), and Google credentials already exchanged from them follow Google's own lifetime (one hour by default), so also remove the IAM binding when you need to cut access at once.

4. The agent exchanges the ID token at `https://sts.googleapis.com/v1/token`. `/llms.txt` has the exact request.

The token's `aud` is the audience exactly as the agent requested it. With no `--allowed-audiences` set (as above), Google accepts both the `https://iam.googleapis.com/...` and `//iam.googleapis.com/...` spellings. If you set `--allowed-audiences`, the agent must request one of those values verbatim, and only the provider resource name forms are supported.

Before production rollout you can test the exchange against a provider created with `--jwk-json-path` (the contents of `/.well-known/jwks.json`) so Google does not need to reach the issuer.

## Git Credential Helper

For HTTPS `git push`, install the credential helper (Node 24 and Git 2.26 or newer) with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/concertypin/deplodash/main/apps/api/scripts/install-credential-helper.sh | sh
```

Before changing anything it explains the `useHttpPath` side effect below and asks you to confirm. Where it cannot ask (an agent VM, CI, or `curl | sh` on Windows), it stops without changes; rerun with `--yes` to accept: `curl -fsSL https://raw.githubusercontent.com/concertypin/deplodash/main/apps/api/scripts/install-credential-helper.sh | sh -s -- --yes`.

The installer prompts for your agent token, stores it in a private runner under `~/.local/share/deplodash`, and registers the helper for `https://github.com` ahead of every existing credential provider, including system-level ones such as GCM (Git for Windows) or osxkeychain (Apple Git). The providers that were active before stay registered after it as a fallback, and your generic `credential.helper` settings are left untouched. Helpers scoped to a path or user name under github.com, or set through `includeIf`, are reset for github.com; the installer prints a warning when it finds them. The fallback list is copied at install time, so rerun the installer after changing your system or generic credential helper; until then a newly added helper is not wrapped and could store the short-lived Deplodash token. It does not put the token in Git configuration. It sets `credential.https://github.com.useHttpPath=true`, because Git only tells credential helpers which repository is being accessed when this is set; as a side effect, a fallback provider stores GitHub credentials per repository instead of per host. Because Git does not tell credential helpers which ref is being pushed, the default request conservatively includes both `contents:write` and `workflows:write`; set `DEPLODASH_SCOPES` for an explicit narrower scope set, and `DEPLODASH_REPO_MODE=create-if-missing` to opt in to automatic repository creation. When the helper cannot produce a token (for example consent is pending, or the repository is not managed by Deplodash) it prints a diagnostic to stderr and returns nothing, so Git falls through to your other credential providers instead of stopping. Approve the consent URL printed to stderr, then retry `git push`. Note that Git's approve phase sends the issued token to every configured helper; the installer registers each fallback provider through a small wrapper (`deplodash-credential-fallback.ts`) that runs it exactly as Git would but drops that `store` request for GitHub App installation tokens (`ghs_…`), so fallback providers never cache the short-lived Deplodash token. A credential helper configured in a single repository's own `.git/config` is not wrapped and could still store it; per-repository helpers are rare, so the installer leaves repository config alone. On Windows (no POSIX `/dev/tty`), set `$env:DEPLODASH_AGENT_TOKEN` before running the installer to avoid a visible-input prompt.

## OAuth Setup

Only needed for the consent page authentication:

1. **GitHub** → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Set **Authorization callback URL** to your app's `/callback`
   - Local: `http://localhost:5178/callback`
   - Production: `https://your-worker.workers.dev/callback`
3. Copy the Client ID and Client Secret to `.dev.vars`

## Architecture

See [`AGENTS.md`](./AGENTS.md) for the full module reference.

## Deploy

```sh
# Set secrets (one-time)
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put CALLBACK_URL
pnpm exec wrangler secret put ENCRYPTION_SECRET
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY

# Update KV namespace ID in apps/api/wrangler.jsonc, then deploy
pnpm deploy
```

## License

Apache-2.0, see [LICENSE](./LICENSE) for details.
