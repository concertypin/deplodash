/**
 * LLMs route — Agent documentation for Deplodash GitHub App Token API.
 *
 * Served at GET /llms.txt so any agent can discover how to authenticate,
 * request tokens, configure Git credential helpers, and handle permission
 * elevation.
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";

const LLMS_CONTENT = `# Deplodash — Agent API Guide

Deplodash is a GitHub App token service that issues scoped installation tokens for git push and GitHub API access.

## Authentication

All API requests require a bearer token in the Authorization header:

\`\`\`
Authorization: Bearer <agent_token>
\`\`\`

Agent tokens are long-lived, pre-provisioned strings stored in Cloudflare KV. Contact the deplodash admin to obtain one.

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

**Available scopes:** \`contents:read\`, \`contents:write\`, \`workflows:write\`, \`admin\`

**Response (ok):**
\`\`\`json
{
  "status": "ok",
  "token": "ghs_xxxxxxxxxxxx",
  "expires_at": "2026-06-14T20:00:00Z"
}
\`\`\`

**Response (needs consent from user):**
\`\`\`json
{
  "status": "needs_consent",
  "url": "{{BASE}}/auth/consent?repo=owner/repo&scopes=contents%3Awrite"
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
  echo password=$(curl -s -X POST {{BASE}}/api/token \
    -H 'Authorization: Bearer YOUR_AGENT_TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\\"repo\\":\\"owner/repo\\",\\"scopes\\":[\\"contents:write\\"]}' \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
}; f"
\`\`\`

## Permissions

| Scope | GitHub Permissions |
|---|---|
| \`contents:read\` | metadata: read, contents: read |
| \`contents:write\` | metadata: read, contents: write |
| \`workflows:write\` | metadata: read, workflows: write |
| \`admin\` | metadata: read, contents: write, workflows: write, administration: write |

## Support

If you encounter permission errors, the agent will receive a \`needs_consent\` response. Forward the consent URL to a repository admin.
`;

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at / — paths are relative

const { origin } = new URL(import.meta.url);
const BASE_URL = origin.startsWith("http") ? origin : "";

export const llmsRouter = new Hono<HonoEnv>().get("/llms.txt", (c) => {
    const content = LLMS_CONTENT.replaceAll("{{BASE}}", BASE_URL);
    return c.text(content, 200, {
        "Content-Type": "text/plain; charset=utf-8",
    });
});
