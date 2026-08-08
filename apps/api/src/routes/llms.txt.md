# Deplodash — Agent API Guide

Deplodash issues scoped GitHub App installation tokens for agent workflows such as git push and GitHub API access.

## Authentication

### Agent token auth for `POST /api/token`

Request token issuance with a bearer token in the Authorization header:

```
Authorization: Bearer <agent_token>
```

Agent tokens are long-lived strings stored in Cloudflare KV. Provision one from the user dashboard (Login → Issue Agent Token).

### Session auth for user pages and consent

Browser flows such as `GET /auth/github`, `GET /auth/consent`, and `GET /api/user/token` use the session cookie created by the GitHub OAuth flow. A human may open a consent URL directly from the dashboard or follow the URL returned by an agent token request.

## Endpoints

### POST /api/token — Request a GitHub Installation Token

Request a token for a specific repository with desired permissions.

**Request:**

```json
{
    "repo": "owner/repo-name",
    "scopes": ["contents:write"],
    "repo_mode": "existing-only"
}
```

The optional `repo_mode` field (`"existing-only"` or `"create-if-missing"`) indicates whether the agent intends to create the repository if it does not exist. Default is `"existing-only"`, which never creates a repository. With `"create-if-missing"`, the consent page offers the option to create a private repository, but only after explicit human approval. Repository existence is not reported before consent.

**Available scopes:** `contents:read`, `contents:write`, `workflows:write`, `issues:read`, `issues:write`, `pulls:read`, `pulls:write`, `actions:read`, `actions:write`, `checks:read`, `checks:write`, `variables:read`, `variables:write`, `metadata:read`, `deployments:read`, `deployments:write`, `environments:read`, `environments:write`, `administration:read`, `administration:write`, `members:read`, `members:write`, `secrets:read`, `secrets:write`, `pages:read`, `pages:write`, `webhooks:read`, `webhooks:write`. Compound presets (`admin`, `contents:write+workflows:write`) are accepted and expanded to their constituent granular scopes.

**Response (ok):**

```json
{
    "status": "ok",
    "token": "ghs_xxxxxxxxxxxx",
    "expires_at": "2026-06-14T20:00:00Z",
    "effective_scopes": ["contents:write"]
}
```

The returned `effective_scopes` may be narrower than the requested scopes if the repo has only partial consent on record.

If consent is not already recorded, the API returns a direct consent URL:

```json
{
    "status": "needs_consent",
    "url": "{{BASE}}/auth/consent?repo=owner%2Frepo-name&agent_id=my-agent&scopes=contents%3Awrite&repo_mode=existing-only",
    "requested_scopes": ["contents:write"],
    "approved_scopes": ["contents:read"]
}
```

The URL carries the repository, agent ID, requested scopes, and repository mode so a human can approve either an agent-initiated request or a proactive dashboard authorization. The consent page requires an authenticated GitHub session. The server validates the repository authority, approvable scopes, repository mode, and GitHub identity before recording a reusable consent grant in KV.

The consent grant can be approved again with the same parameters; approval is not a one-time transaction. Consent records expire after 90 days and can be revoked from the dashboard.

### QUERY /api/wait — Wait for User Consent (Long Polling)

If you receive a `needs_consent` response from `POST /api/token`, you can use the `QUERY /api/wait` endpoint to wait for the user to approve the request, rather than polling `POST /api/token` repeatedly.

This endpoint supports the HTTP `QUERY` method ([RFC 10008](https://datatracker.ietf.org/doc/rfc10008/)). It takes the exact same authorization header and JSON body as `POST /api/token`.

**Request:**

```json
QUERY /api/wait
Authorization: Bearer <agent_token>
Content-Type: application/json

{
    "repo": "owner/repo-name",
    "scopes": ["contents:write"]
}
```

**Response (ok - Consent Granted):**

- `204 No Content`
- The connection will be kept open (up to 1 minute 30 seconds) until the user grants consent. Once consent is granted, it responds immediately with `204`. You can then call `POST /api/token` again to retrieve your token.

**Response (timeout):**

- `403 Forbidden`
- If the user does not grant consent within 1 minute 30 seconds, the request will time out with a `403` status code.

### GET /api/user/token — Return the signed-in user OAuth token

Uses the session cookie created by the login flow and returns the user OAuth token for browser-driven operations.

## Git Credential Helper

### HTTPS credential helper for git push

Install the Node 24 helper and configure Git in one command:

```sh
curl -fsSL https://raw.githubusercontent.com/concertypin/deplodash/main/apps/api/scripts/install-credential-helper.sh | sh
```

The installer prompts for the long-lived agent token, stores it in a private runner under `~/.local/share/deplodash` rather than Git configuration, enables `credential.useHttpPath`, and registers the helper for GitHub HTTPS without removing your existing credential providers (GCM, keychain). Use an HTTPS GitHub remote such as `https://github.com/owner/repo.git`. Because Git does not tell credential helpers which ref is being pushed, the default request conservatively includes both `contents:write` and `workflows:write`; set `DEPLODASH_SCOPES` for an explicit narrower scope set, and `DEPLODASH_REPO_MODE=create-if-missing` to opt in to automatic repository creation. When the helper cannot produce a token it prints a diagnostic (including the consent URL when approval is pending) to stderr and returns nothing, so Git falls through to other credential providers; approve the consent URL, then retry `git push`.
On Windows (no POSIX `/dev/tty`), set `DEPLODASH_AGENT_TOKEN` before running the installer to avoid a visible-input prompt.

## Permissions

| Scope             | GitHub Permissions                                                       |
| ----------------- | ------------------------------------------------------------------------ |
| `contents:read`   | metadata: read, contents: read                                           |
| `contents:write`  | metadata: read, contents: write                                          |
| `workflows:write` | metadata: read, workflows: write                                         |
| `admin`           | metadata: read, contents: write, workflows: write, administration: write |

## Support

If you encounter permission errors, the agent will receive a `needs_consent` response. Forward the consent URL to a repository admin.
