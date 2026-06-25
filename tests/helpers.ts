/**
 * Shared test helpers for Deplodash tests.
 *
 * Note: KV is NOT mocked here — use `import { env } from "cloudflare:workers"`
 * in test files to access the real in-memory KV provided by the test pool
 * (configured via wrangler.jsonc's `kv_namespaces` binding).
 */

import { assert, expect, vi } from "vitest";
import type { HonoEnv } from "@/types";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Common test encryption secret (16+ chars for AES-256). */
export const TEST_SECRET = "test-secret-1234567890123456";

/**
 * Minimal test bindings factory.
 *
 * Override any binding via the `overrides` param. KV is sourced from
 * `cloudflare:workers` env by default — each test file must supply its own
 * `import { env } from "cloudflare:workers"` and pass `env.KV` if needed.
 *
 * @example
 * ```ts
 * const env = makeBaseEnv({ GITHUB_ADMIN_USERS: "admin-user" });
 * ```
 */
export function makeBaseEnv(
    overrides?: Partial<HonoEnv["Bindings"]>
): HonoEnv["Bindings"] {
    return {
        ENCRYPTION_SECRET: TEST_SECRET,
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        CALLBACK_URL: "http://localhost:5178/callback",
        KV: undefined as unknown as KVNamespace, // caller must assign env.KV
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY:
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
        TOKEN_RATE_LIMITER: {
            limit: vi.fn<
                (_options: { key: string }) => Promise<{ success: boolean }>
            >(() => Promise.resolve({ success: true })),
        },
        ...overrides,
    };
}

/**
 * Create a JSON response for fetch mocks.
 */
export function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * Delete all keys in the given KV namespace.
 * Call in beforeEach to give each test a clean slate.
 */
export async function clearKV(kv: KVNamespace): Promise<void> {
    const { keys } = await kv.list();
    if (keys.length > 0) {
        await Promise.all(keys.map((k) => kv.delete(k.name)));
    }
}

/**
 * Generate an RSA 2048-bit key pair and return the private key in PKCS#8 PEM format.
 * Useful for creating realistic GitHub App private keys in tests.
 */
export async function generateTestKeyPair(): Promise<{
    pkcs8Pem: string;
    keyPair: CryptoKeyPair;
}> {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
    const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    return { pkcs8Pem, keyPair };
}

/**
 * KVNamespace proxy that throws on any property access.
 *
 * Use in `it.concurrent` tests to guarantee they never accidentally read
 * or write KV — a concurrent test touching KV would cause data races with
 * other concurrent tests sharing the same Worker isolate.
 *
 * @example
 * ```ts
 * const env: HonoEnv["Bindings"] = { ...BASE_ENV, KV: THROWING_KV };
 * ```
 */
export const THROWING_KV = new Proxy({} as KVNamespace, {
    get() {
        throw new Error(
            "Concurrent test attempted KV access — " +
                "move this test to a non-concurrent describe block (KV is not isolated per test)."
        );
    },
});

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

// Intended, obj might contain any key
/**
 * Asserts that the given `body` object contains the specified property `prop`.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export function contains<T extends keyof any>(
    obj: unknown,
    prop: T
): asserts obj is { [K in T]: unknown } {
    assert(obj);
    assert(typeof obj === "object");
    assert(prop in obj);
}
