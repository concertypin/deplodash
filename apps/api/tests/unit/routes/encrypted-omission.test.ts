import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { contains } from "@tests/helpers";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { env } from "cloudflare:workers";

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

describe("Encrypted consent field omission (KV required)", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        mockFetch = vi.fn<typeof fetch>();
        mockFetch.mockResolvedValue(
            Response.json({
                login: "testuser",
                id: 1,
                avatar_url: "",
                name: "Test User",
            })
        );
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("omitting encrypted field is rejected when ENCRYPTION_SECRET is configured", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "injected/repo",
                    scopes: "contents:read",
                    requested_scopes: "contents:read",
                    agent_id: "injected-agent",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain(
            "Invalid consent request. Missing encrypted payload."
        );
    });
});
