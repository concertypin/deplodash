import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { tokenRouter } from "@/routes/token";
import { TokenService } from "@/token/service";
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

describe("QUERY /wait", () => {
    let kv: KVNamespace;
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
        c.env = BASE_ENV;
        await next();
    });
    app.route("/api", tokenRouter);

    beforeEach(async () => {
        kv = env.KV;
        vi.useFakeTimers();
        await registerAgentToken(
            kv,
            "test-agent-token",
            "test-agent-123",
            "Test Agent"
        );
    });

    afterEach(async () => {
        const list = await kv.list();
        await Promise.all(list.keys.map((k) => kv.delete(k.name)));
        vi.useRealTimers();
    });

    it("should return 204 immediately if consent is already granted", async () => {
        const tokenService = new TokenService(kv);
        await tokenService.recordConsent(
            "test-agent-123",
            "owner/repo",
            ["contents:read"],
            ["contents:read"],
            "test-user"
        );

        const req = new Request("http://localhost/api/wait", {
            method: "QUERY",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer test-agent-token",
            },
            body: JSON.stringify({
                repo: "owner/repo",
                scopes: ["contents:read"],
            }),
        });

        const res = await app.fetch(req);
        expect(res.status).toBe(204);
    });

    it("should return 403 on timeout if consent is never granted", async () => {
        const req = new Request("http://localhost/api/wait", {
            method: "QUERY",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer test-agent-token",
            },
            body: JSON.stringify({
                repo: "owner/repo",
                scopes: ["contents:read"],
            }),
        });

        const fetchPromise = app.fetch(req);

        // Advance timers to trigger the 90s timeout
        await vi.advanceTimersByTimeAsync(91000);

        const res = await fetchPromise;
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data).toHaveProperty(
            "error",
            "Timeout waiting for consent approval"
        );
    });

    it("should return 204 when consent is granted while polling", async () => {
        const req = new Request("http://localhost/api/wait", {
            method: "QUERY",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer test-agent-token",
            },
            body: JSON.stringify({
                repo: "owner/repo",
                scopes: ["contents:read"],
            }),
        });

        const fetchPromise = app.fetch(req);

        // Advance timers by 10s (two 5s polls)
        await vi.advanceTimersByTimeAsync(10000);

        // Record consent
        const tokenService = new TokenService(kv);
        await tokenService.recordConsent(
            "test-agent-123",
            "owner/repo",
            ["contents:read"],
            ["contents:read"],
            "test-user"
        );

        // Advance timer to trigger next poll
        await vi.advanceTimersByTimeAsync(5000);

        const res = await fetchPromise;
        expect(res.status).toBe(204);
    });
});
