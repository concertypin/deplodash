import {
    describe,
    expect,
    it,
    vi,
    beforeAll,
    beforeEach,
    afterEach,
} from "vitest";
import { jsonResponse } from "@tests/helpers";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { tokenRouter } from "@/routes/token";
import { TokenService } from "@/token/service";
import { env } from "cloudflare:workers";
import { registerAgentToken } from "@/middleware/agent-auth";

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
};

describe("Cross-agent consent isolation", () => {
    let pkcs8Pem: string;
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

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
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Agent A's consent does not authorize Agent B", async () => {
        await registerAgentToken(
            BASE_ENV.KV,
            "agent-a-token",
            "agent-a",
            "Agent A"
        );
        await registerAgentToken(
            BASE_ENV.KV,
            "agent-b-token",
            "agent-b",
            "Agent B"
        );
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("agent-a", "shared/repo", [
            "contents:read",
        ]);

        // mockFetch will be called by repoExists check before needs_consent response
        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 77, account: { login: "shared" } })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_token",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ name: "repo" }));

        const app = new Hono<HonoEnv>().route("/api", tokenRouter);
        const client = testClient(app, {
            ...BASE_ENV,
            GITHUB_APP_PRIVATE_KEY: pkcs8Pem,
            KV: env.KV,
        });
        const resp = await client.api.token.$post(
            { json: { repo: "shared/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer agent-b-token" } }
        );
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("needs_consent");
        // fetch is called for repo existence check (3 calls), not for creation
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("Agent A's token request succeeds with own consent", async () => {
        await registerAgentToken(
            BASE_ENV.KV,
            "agent-a-token-2",
            "agent-a",
            "Agent A"
        );
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("agent-a", "owner/repo", [
            "contents:read",
        ]);

        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 999, account: { login: "owner" } })
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
                    token: "ghs_agent_a_token",
                    expires_at: "2027-06-01T00:00:00Z",
                    permissions: { contents: "read" },
                    repository_selection: "selected",
                })
            );

        const app = new Hono<HonoEnv>().route("/api", tokenRouter);
        const client = testClient(app, {
            ...BASE_ENV,
            GITHUB_APP_PRIVATE_KEY: pkcs8Pem,
            KV: env.KV,
        });
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer agent-a-token-2" } }
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.token).toBe("ghs_agent_a_token");
    });
});
