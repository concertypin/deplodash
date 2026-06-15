- `unit/` - Unit tests using Vitest

Tests mirror `src/` structure for easy mapping.

## KV Binding Isolation

KV is provided by `import { env } from "cloudflare:workers"` → `env.KV` (in-memory KV from
`@cloudflare/vitest-pool-workers`, configured via `wrangler.jsonc`'s `kv_namespaces`).

- **Between files**: Each test file runs in its own Worker isolate → KV is naturally isolated.
- **Within a file**: Tests run sequentially by default (Vitest default), so KV sharing is safe.
- **⚠️ Do NOT use `test.concurrent`** on tests that read/write KV. `env.KV` is shared across
  all tests in the same file, so parallel execution would cause data races.
- `token-service.test.ts` manually clears KV keys in `beforeEach` for per-test isolation.
