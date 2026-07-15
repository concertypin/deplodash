import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { TEST_SECRET, jsonResponse } from "../../helpers";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { tokenRouter } from "@/routes/token";
import { TokenService } from "@/token/service";
import { env } from "cloudflare:workers";
import { registerAgentToken } from "@/middleware/agent-auth";

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

describe("POST /api/token — Full grant flow", () => {
    let pkcs8Pem: string;
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);

    function makeEnv(pem: string): HonoEnv["Bindings"] {
        return { ...BASE_ENV, GITHUB_APP_PRIVATE_KEY: pem, KV: env.KV };
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
        const pkcs8 = await crypto.subtle.exportKey(
            "pkcs8",
            keyPair.privateKey
        );
        const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
        const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
        pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    });

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
        await registerAgentToken(
            BASE_ENV.KV,
            "flow-agent-token",
            "test-agent",
            "Flow Test Agent"
        );
    });

    it("returns 200 with token when consent exists", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "owner/repo", [
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

        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(typeof body.token).toBe("string");
    });

    it("returns 202 needs_consent without creating repo when no consent", async () => {
        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "other/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("needs_consent");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns 200 with token for repo with admin scope", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "admin/repo", ["admin"]);
        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 999, account: { login: "admin" } })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_token_999",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ name: "repo" }))
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_admin_scoped",
                    expires_at: "2027-06-01T00:00:00Z",
                    permissions: {
                        contents: "write",
                        workflows: "write",
                        administration: "write",
                    },
                    repository_selection: "selected",
                })
            );

        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "admin/repo", scopes: ["admin"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
    });

    it("creates repo and issues token when repo does not exist", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "neworg/new-repo", [
            "contents:write",
        ]);
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

        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "neworg/new-repo", scopes: ["contents:write"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.token).toBe("ghs_created_repo_token");
    });

    it("returns 429 when rate limit is exceeded", async () => {
        mockRateLimiter.limit.mockResolvedValueOnce({ success: false });
        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(429);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toContain("Rate limited");
    });

    it("proceeds normally when rate limiter is not configured", async () => {
        const envWithoutRl: HonoEnv["Bindings"] = {
            ...makeEnv(pkcs8Pem),
            TOKEN_RATE_LIMITER: undefined as unknown as RateLimit,
        };
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "norl/repo", [
            "contents:read",
        ]);
        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 55, account: { login: "norl" } })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_token",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ name: "repo" }))
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_rl_disabled",
                    expires_at: "2027-01-01T00:00:00Z",
                    permissions: { contents: "read" },
                    repository_selection: "selected",
                })
            );

        const client = testClient(app, envWithoutRl);
        const resp = await client.api.token.$post(
            { json: { repo: "norl/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.token).toBe("ghs_rl_disabled");
    });

    it("sanitizes error responses — does not leak GitHub API body details", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "leaky/repo", [
            "contents:read",
        ]);
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ message: "Sensitive internal error details" }, 500)
        );
        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "leaky/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(500);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).not.toContain("Sensitive internal error details");
    });

    it("returns generic error message for non-matching error patterns", async () => {
        const badKeyEnv = makeEnv("not-a-valid-key-at-all");
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "weird/repo", [
            "contents:read",
        ]);
        const client = testClient(app, badKeyEnv);
        const resp = await client.api.token.$post(
            { json: { repo: "weird/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );
        expect(resp.status).toBe(500);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).not.toContain("not-a-valid-key");
        expect(body.error).toContain("internal error");
    });
});
