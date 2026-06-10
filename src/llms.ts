// llms.txt — Agent documentation for Deplodash GitHub App Token API.
//
// Served at GET /llms.txt so any agent can discover how to authenticate,
// request tokens, configure Git credential helpers, and handle permission
// elevation.

import { escapeHtml } from "./helpers.ts";

const LLMS_CONTENT = `# Deplodash — Agent API Guide

Deplodash is a GitHub App token service that issues scoped installation tokens for git push and GitHub API access.

## Authentication

All API requests require a bearer token in the Authorization header:

\`\`\`
Authorization: Bearer <agent_token>
\`\`\`

Agent tokens are long-lived, pre-provisioned strings. Contact the deplodash admin to obtain one.

## Endpoints

### POST /api/token — Request a GitHub Installation Token

Request a token for a specific repository with desired permissions.

**Request:**
\`\`\`json
{
  "repo": "owner/repo-name",
  "scopes": ["contents:write"]
}
\`\`\`

**Available scopes:** \`contents:read\`, \`contents:write\`, \`workflows:write\`

**Response (ok):**
\`\`\`json
{
  "status": "ok",
  "token": "ghs_xxxxxxxxxxxx",
  "expires_at": "2026-06-10T20:00:00Z"
}
\`\`\`

**Response (needs consent from user):**
\`\`\`json
{
  "status": "needs_consent",
  "url": "https://deplodash.concertypin.deno.net/auth/consent?repo=...&scopes=...&token=..."
}
\`\`\`

Send the consent URL to the user. Once they approve, retry the request — the next call will return a token.

## Git Credential Helper

### HTTPS with credential helper (persistent)

\`\`\`sh
# Set remote to HTTPS (not SSH)
git remote set-url origin https://github.com/owner/repo.git

# Configure credential helper to fetch tokens from deplodash
git config credential.helper "!f() {
  echo username=x-access-token
  echo password=\\$(curl -sf -H 'Authorization: Bearer \$AGENT_TOKEN' \\
    'https://deplodash.concertypin.deno.net/api/token' \\
    -d '{\"repo\":\"owner/repo\",\"scopes\":[\"contents:write\"]}' \\
    | sed 's/.*"token":"\\([^"]*\\)".*/\\1/')
}; f"
\`\`\`

### One-shot push (no credential helper)

\`\`\`sh
# Get a token directly
TOKEN=\\$(curl -sf -H 'Authorization: Bearer \$AGENT_TOKEN' \\
  'https://deplodash.concertypin.deno.net/api/token' \\
  -d '{"repo":"owner/repo","scopes":["contents:write"]}' \\
  | sed 's/.*"token":"\\([^"]*\\)".*/\\1/')
echo "Token: \$TOKEN"

# Use it for a single push
git -c http.extraHeader="Authorization: Bearer \$TOKEN" push origin main
\`\`\`

## Handling Permission Elevation

When a git push fails because the token lacks \`workflows:write\` permission:

\`\`\`
! [remote rejected] main -> main (refusing to allow an OAuth App
  to create or update workflow \`.github/workflows/ci.yml\` without
  \`workflow\` scope)
\`\`\`

**Solution:** Request an elevated token with \`workflows:write\` included:

\`\`\`sh
curl -H 'Authorization: Bearer \$AGENT_TOKEN' \\
  -d '{"repo":"owner/repo","scopes":["contents:write","workflows:write"]}' \\
  'https://deplodash.concertypin.deno.net/api/token'
\`\`\`

The first time this is attempted, the response will include a consent URL.
Forward it to the user. After they approve, subsequent requests will return
a fully scoped token.

## Token Caching

Deplodash caches GitHub installation tokens in Deno KV until 5 minutes before
expiry (max lifetime: 1 hour). Repeated requests for the same repo + scopes
return the cached token. No action needed on the agent side.
`;

export function renderLLMsTxt(): Response {
  return new Response(LLMS_CONTENT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
