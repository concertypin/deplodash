import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { tokenRouter } from "@/routes/token";
import { resetKeyCache } from "@/crypto";
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
    TOKEN_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
};

describe("POST /api/token — body size limit", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);

    beforeEach(() => {
        resetKeyCache();
    });

    it("rejects request body larger than 50 KiB with 413", async () => {
        // Create a JSON payload where the repo field alone exceeds 50 KiB
        const largeRepo = "a".repeat(60 * 1024); // ~60 KiB string
        const body = JSON.stringify({
            repo: `owner/${largeRepo}`,
            scopes: ["contents:read"],
        });

        expect(body.length).toBeGreaterThan(50 * 1024);

        const resp = await app.fetch(
            new Request("http://localhost/api/token", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer test-agent-token",
                },
                body,
            }),
            BASE_ENV
        );

        expect(resp.status).toBe(413);
    });

    it("accepts request body within 50 KiB limit", async () => {
        const body = JSON.stringify({
            repo: "owner/small-repo",
            scopes: ["contents:read"],
        });

        expect(body.length).toBeLessThan(50 * 1024);

        const resp = await app.fetch(
            new Request("http://localhost/api/token", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer test-agent-token",
                },
                body,
            }),
            BASE_ENV
        );

        // Should return 202 (needs consent) because the body is valid, not 413
        expect(resp.status).not.toBe(413);
    });
});
