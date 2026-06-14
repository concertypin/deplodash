/**
 * Shared test helpers for Deplodash tests.
 */

/**
 * Create a minimal mock KVNamespace for testing.
 *
 * Note: This is an incomplete mock covering only the methods used by the codebase.
 * If the real KVNamespace interface changes, this will need updating.
 * TODO: Replace with @cloudflare/vitest-pool-workers' built-in KV mock when available.
 */
export function mockKVNamespace(): KVNamespace {
    const store = new Map<string, string>();
    return {
        get: (
            key: string,
            options?: { type?: string } | string
        ): Promise<string | Record<string, unknown> | null> => {
            const raw = store.get(key) ?? null;
            if (raw === null) return Promise.resolve(null);
            const type = typeof options === "string" ? options : options?.type;
            if (type === "json") return Promise.resolve(JSON.parse(raw));
            return Promise.resolve(raw);
        },
        put: (key: string, value: string): Promise<void> => {
            store.set(key, value);
            return Promise.resolve();
        },
        delete: (key: string): Promise<void> => {
            store.delete(key);
            return Promise.resolve();
        },
        list: (options?: {
            prefix?: string;
        }): Promise<{
            keys: { name: string; expiration?: number }[];
            list_complete: boolean;
        }> => {
            const keys: { name: string }[] = [];
            for (const name of store.keys()) {
                if (!options?.prefix || name.startsWith(options.prefix)) {
                    keys.push({ name });
                }
            }
            return Promise.resolve({ keys, list_complete: true });
        },
    } as unknown as KVNamespace;
}
