import {
    afterEach,
    assert,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { testClient } from "hono/testing";
import app from "@/index";
import type { HonoEnv } from "@/types";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token-service";
import { registerAgentToken } from "@/middleware/agent-auth";
import { resetKeyCache } from "@/crypto";

const TEST_SECRET = "test-secret-1234567890123456";

const mockRateLimiter = {
    limit: vi.fn<(_options: { key: string }) => Promise<{ success: boolean }>>(
        () => Promise.resolve({ success: true })
    ),
};

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    TOKEN_RATE_LIMITER: mockRateLimiter,
};

let pkcs8Pem = BASE_ENV.GITHUB_APP_PRIVATE_KEY;
let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

async function clearKv(): Promise<void> {
    const { keys } = await env.KV.list();
    await Promise.all(keys.map((key) => env.KV.delete(key.name)));
}

function makeEnv(): HonoEnv["Bindings"] {
    return {
        ...BASE_ENV,
        GITHUB_APP_PRIVATE_KEY: pkcs8Pem,
    };
}

function makeClient() {
    return testClient(app, makeEnv());
}

beforeAll(async () => {
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
    pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
});

beforeEach(async () => {
    resetKeyCache();
    await clearKv();
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("API token E2E flow", () => {
    it("issues a token for a consented repo and reuses the cache on the next request", async () => {
        const client = makeClient();

        await registerAgentToken(
            env.KV,
            "agent-token-e2e",
            "agent-1",
            "E2E Agent"
        );

        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("agent-1", "owner/repo", [
            "contents:read",
        ]);

        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 12345, account: { login: "owner" } })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_token_123",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ name: "repo" }))
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_scoped_token_456",
                    expires_at: "2027-01-01T00:00:00Z",
                    permissions: { contents: "read" },
                    repository_selection: "selected",
                })
            );

        const first = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer agent-token-e2e" } }
        );

        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as Record<string, unknown>;
        expect(firstBody).toMatchObject({
            status: "ok",
            token: "ghs_scoped_token_456",
        });
        expect(typeof firstBody.expires_at).toBe("string");
        expect(Array.isArray(firstBody.effective_scopes)).toBe(true);
        expect(firstBody.effective_scopes).toEqual(["contents:read"]);

        expect(mockFetch).toHaveBeenCalledTimes(4);

        const second = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer agent-token-e2e" } }
        );

        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as Record<string, unknown>;
        expect(secondBody).toMatchObject({
            status: "ok",
            token: "ghs_scoped_token_456",
        });
        expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("auto-creates a missing repo before issuing the token", async () => {
        const client = makeClient();

        await registerAgentToken(
            env.KV,
            "agent-token-create",
            "agent-2",
            "Create Agent"
        );

        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent(
            "agent-2",
            "neworg/new-repo",
            ["contents:write", "administration:write"],
            undefined,
            undefined,
            "create-if-missing"
        );

        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 77, account: { login: "neworg" } })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_create_token",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ message: "Not found" }, 404))
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_create_token",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ login: "neworg" }))
            .mockResolvedValueOnce(
                jsonResponse(
                    { name: "new-repo", full_name: "neworg/new-repo" },
                    201
                )
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_created_repo_token",
                    expires_at: "2027-03-01T00:00:00Z",
                    permissions: { contents: "write" },
                    repository_selection: "selected",
                })
            );

        const resp = await client.api.token.$post(
            {
                json: {
                    repo: "neworg/new-repo",
                    scopes: ["contents:write", "administration:write"],
                },
            },
            { headers: { Authorization: "Bearer agent-token-create" } }
        );

        expect(resp.status).toBe(200);
        const body = (await resp.json()) satisfies Record<string, unknown>;
        assert(
            "error" in body === false,
            "Response should not contain an error"
        );
        expect(body).toMatchObject({
            status: "ok",
            token: "ghs_created_repo_token",
        });
        assert(
            "expires_at" in body && typeof body.expires_at === "string",
            "expires_at should be a string"
        );
        expect(body.effective_scopes).toEqual([
            "contents:write",
            "administration:write",
        ]);
        expect(mockFetch).toHaveBeenCalledTimes(7);
    });
    it("rejects requests without an agent bearer token", async () => {
        const client = makeClient();

        const resp = await client.api.token.$post({
            json: {
                repo: "owner/repo",
                scopes: ["contents:read"],
            },
        });

        expect(resp.status).toBe(401);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toBe("Missing or invalid Authorization header");
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
