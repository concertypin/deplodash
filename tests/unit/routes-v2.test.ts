import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { tokenRouter } from "@/routes/token";
import { llmsRouter } from "@/routes/llms";
import { authRouter } from "@/routes/auth";
import { resetKeyCache } from "@/crypto";
import { env } from "cloudflare:workers";
import { registerAgentToken } from "@/middleware/agent-auth";

const errorResponseSchema = z.object({ error: z.string() });

// ─── Test helpers ────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-1234567890123456";
const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    GITHUB_INSTALLATION_ID: "654321",
};

beforeEach(() => {
    resetKeyCache();
});

describe("GET /llms.txt", () => {
    const app = new Hono<HonoEnv>().route("/", llmsRouter);
    const client = testClient(app, BASE_ENV);

    it("returns llms.txt content", async () => {
        const resp = await client["llms.txt"].$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("/api/token");
        expect(resp.headers.get("Content-Type")).toContain("text/plain");
    });
});

describe("GET /auth/consent", () => {
    const app = new Hono<HonoEnv>()
        .route("/auth", authRouter)
        .route("/auth", consentRouter);
    const client = testClient(app, BASE_ENV);

    it("redirects to login when not authenticated", async () => {
        const resp = await client.auth.consent.$get({
            query: { repo: "owner/repo", scopes: "contents:read" },
        });
        // authGuard renders login page since not authenticated
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("/auth/github");
    });
});

describe("POST /api/token (without auth)", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);
    const client = testClient(app, BASE_ENV);

    it("returns 401 when no bearer token", async () => {
        const resp = await client.api.token.$post({
            json: { repo: "owner/repo", scopes: ["contents:read"] },
        });
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toBeTruthy();
    });

    it("returns 401 when bearer token is invalid", async () => {
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer invalid_token" } }
        );
        expect(resp.status).toBe(401);
    });
});

describe("POST /api/token (authenticated, needs consent)", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);
    const client = testClient(app, BASE_ENV);

    beforeEach(async () => {
        await registerAgentToken(
            BASE_ENV.KV,
            "test-agent-token",
            "test-agent",
            "Test Agent"
        );
    });

    it("fails with 500 because ensureRepoExists requires a real GitHub App", async () => {
        // The test environment has a fake GitHub App private key, so
        // ensureRepoExists (which runs before consent check) will fail.
        const resp = await client.api.token.$post(
            {
                json: { repo: "owner/repo", scopes: ["contents:read"] },
            },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        expect(resp.status).toBe(500);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toBeTruthy();
    });
});
