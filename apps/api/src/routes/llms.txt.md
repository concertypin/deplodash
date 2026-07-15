# Deplodash — Agent API Guide

Deplodash issues scoped GitHub App installation tokens for agent workflows such as git push and GitHub API access.

## Authentication

### Agent token auth for `POST /api/token`

Request token issuance with a bearer token in the Authorization header:

```
Authorization: Bearer <agent_token>
```

Agent tokens are long-lived strings stored in Cloudflare KV. Ask the deplodash admin to provision one.

### Session auth for user pages and consent

Browser flows such as `GET /auth/github`, `GET /auth/consent`, and `GET /api/user/token` use the session cookie created by the GitHub OAuth flow.

## Endpoints

### POST /api/token — Request a GitHub Installation Token

Request a token for a specific repository with desired permissions.

**Request:**

```json
{
    "repo": "owner/repo-name",
    "scopes": ["contents:write"]
}
```

**Available scopes:** `contents:read`, `contents:write`, `workflows:write`, `admin`

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

**Response (needs consent from user):**

```json
{
    "status": "needs_consent",
    "url": "{{BASE}}/auth/consent?repo=owner/repo&scopes=contents%3Awrite",
    "requested_scopes": ["contents:write"],
    "approved_scopes": ["contents:read"]
}
```

Send the consent URL to the user. Once they approve, retry the request. If the user already approved some compatible scopes, the response may include those as `approved_scopes`.

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

### HTTPS with credential helper (persistent)

```sh
# Set remote to HTTPS (not SSH)
git remote set-url origin https://github.com/owner/repo.git

# Configure credential helper to fetch tokens from deplodash
git config credential.helper "!f() {
  echo username=x-access-token
  echo password=$(curl -s -X POST {{BASE}}/api/token     -H 'Authorization: Bearer YOUR_AGENT_TOKEN'     -H 'Content-Type: application/json'     -d '{\"repo\":\"owner/repo\",\"scopes\":[\"contents:write\"]}'     | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
}; f"
```

## Permissions

| Scope             | GitHub Permissions                                                       |
| ----------------- | ------------------------------------------------------------------------ |
| `contents:read`   | metadata: read, contents: read                                           |
| `contents:write`  | metadata: read, contents: write                                          |
| `workflows:write` | metadata: read, workflows: write                                         |
| `admin`           | metadata: read, contents: write, workflows: write, administration: write |

## Support

If you encounter permission errors, the agent will receive a `needs_consent` response. Forward the consent URL to a repository admin.
