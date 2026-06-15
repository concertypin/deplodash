/**
 * Shared test helpers for Deplodash tests.
 *
 * Note: KV is NOT mocked here — use `import { env } from "cloudflare:workers"`
 * in test files to access the real in-memory KV provided by the test pool
 * (configured via wrangler.jsonc's `kv_namespaces` binding).
 */

import { expect } from "vitest";

/**
 * Creates a strict mock proxy that makes tests fail (softly) when accessing
 * unimplemented properties — preventing false positives from incomplete mocks.
 *
 * @template Target The target object type defining all expected properties.
 * @param obj A partial implementation to wrap in a strict proxy.
 * @returns A proxy that enforces strict property access via `expect.soft`.
 *
 * @example
 * ```ts
 * const mock = strictMock<SomeService>({ get: vi.fn() });
 * ```
 */
export function strictMock<const Target extends object>(
    obj: NoInfer<Partial<Target>>
): Target {
    return new Proxy<Target>(obj as Target, {
        get(target: Target, prop, receiver) {
            if (prop in target) {
                return Reflect.get(target, prop, receiver);
            }
            // Allow 'then' property access for proper Promise/await behavior.
            // JavaScript checks for 'then' to determine if an object is thenable.
            if (prop === "then") {
                return undefined;
            }
            expect
                .soft(
                    false,
                    `Property ${String(prop)} is not implemented on strict mock.`
                )
                .toBeTruthy();
        },
    });
}
