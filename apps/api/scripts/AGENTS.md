This directory is not a source code for production, but to save config files and scripts related to CI/CD, build, tests, etc.

## Agent Token Manager

`agent-token-manager.ts` — CLI tool for managing deplodash agent tokens in KV.

```bash
pnpm run token list [--local]
pnpm run token create <agent-id> [--label <name>] [--local]
pnpm run token revoke <token> [--local]
```

- `list` — Show all registered tokens with metadata
- `create <agent-id>` — Generate a new random token for the given agent
- `revoke <token>` — Delete a token (prevents API access)
- `--local` — Target local KV (for `pnpm dev` / wrangler dev)

The tool reads/writes KV keys with prefix `agent_tokens:`.
Requires Node 24+ (native TypeScript stripping, no `--experimental-strip-types` flag needed).
