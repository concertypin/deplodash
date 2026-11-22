This directory is not a source code for production, but to save config files and scripts related to CI/CD, build, tests, etc.

## Agent Token Manager

`agent-token-manager.ts` — CLI tool for managing deplodash agent tokens in KV.

> The `pnpm run token` package alias was removed. Use the direct Node command below or the dashboard; do not restore the alias.

Direct invocation from `apps/api`:

```bash
node scripts/agent-token-manager.ts list [--local]
node scripts/agent-token-manager.ts create <agent-id> [--label <name>] [--local]
node scripts/agent-token-manager.ts revoke <token> [--local]
```

- `list` — Show all registered tokens with metadata
- `create <agent-id>` — Generate a new random token for the given agent
- `revoke <token>` — Delete a token (prevents API access)
- `--local` — Target local KV (for `pnpm dev` / wrangler dev)

The tool reads/writes KV keys with prefix `agent_tokens:`.
Requires Node 24+ (native TypeScript stripping, no `--experimental-strip-types` flag needed).

## Git Credential Helper

`deplodash-credential-helper.ts` is the Git credential helper end users run; `install-credential-helper.sh` / `.ts` install it (users fetch them from the `main` branch on raw.githubusercontent.com, so these files ship to users as-is).

- The helper is downloaded as a standalone file and cannot import from `src/`. It carries its own copy of the scope tables; `deplodash-credential-helper.test.ts` fails when they drift from `src/github/scopes.ts`.
- The installer rebuilds the global `credential.https://github.com` section: an empty-value reset, the Deplodash runner, then the previously effective helpers as fallbacks, plus `useHttpPath=true` (without it Git never sends the repository path to helpers).
- Each fallback is registered as `!node <install dir>/deplodash-credential-fallback.ts '<original helper>'`. The wrapper forwards get/store/erase through `git -c credential.helper= -c credential.helper=<original> credential ...` and drops `store` for `ghs_` installation tokens; a reinstall unwraps existing entries before wrapping them again.
- Tests run under `node:test` via `pnpm run test:credential`, not the Workers Vitest pool.
- Fallbacks include every host-wide spelling of github.com (`https://GitHub.com`, trailing slash, `:443`). Helpers scoped to a path or user name under github.com, and `includeIf` files, are reset by the section and only reported as warnings, never widened to all repositories. The installer needs Git 2.26+ (`git config --show-scope`).
