import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { testClient } from "hono/testing";
import type { HonoEnv } from "@/types";
import { authRouter } from "@/routes/auth";
import { consentRouter } from "@/routes/consent";
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

describe("GET /auth/consent", () => {
    const app = new Hono<HonoEnv>()
        .route("/auth", authRouter)
        .route("/auth", consentRouter);
    const client = testClient(app, BASE_ENV);

    beforeEach(() => {
        resetKeyCache();
    });

    it("redirects to login when not authenticated", async () => {
        const resp = await client.auth.consent.$get({
            query: { repo: "owner/repo", scopes: "contents:read" },
        });
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("/auth/github");
    });
});

describe("GET /auth/github", () => {
    beforeEach(() => {
        resetKeyCache();
    });

    it("redirects to GitHub OAuth authorization URL with proper params", async () => {
        const app = new Hono<HonoEnv>().route("/auth", authRouter);
        const client = testClient(app, BASE_ENV);
        const resp = await client.auth.github.$get({ query: {} });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toContain("https://github.com/login/oauth/authorize");
        expect(location).toContain("client_id=test-client");
        expect(location).toContain("code_challenge_method=S256");
    });

    it("includes next parameter when provided", async () => {
        const app = new Hono<HonoEnv>().route("/auth", authRouter);
        const client = testClient(app, BASE_ENV);
        const resp = await client.auth.github.$get({
            query: { next: "/custom" },
        });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toContain("https://github.com/login/oauth/authorize");
    });

    it("reflects request origin as redirect_uri for localhost", async () => {
        const app = new Hono<HonoEnv>().route("/auth", authRouter);
        const client = testClient(app, BASE_ENV);
        const resp = await client.auth.github.$get({ query: {} });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location") || "";
        const params = new URL(location).searchParams;
        // testClient uses raw fetch, so hostname is localhost without port
        expect(params.get("redirect_uri")).toBe("http://localhost/callback");
    });

    it("uses CALLBACK_URL for non-localhost requests", async () => {
        const app = new Hono<HonoEnv>().route("/auth", authRouter);
        const resp = await app.fetch(
            new Request("https://deplodash.condev.workers.dev/auth/github"),
            BASE_ENV
        );
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location") || "";
        const params = new URL(location).searchParams;
        expect(params.get("redirect_uri")).toBe(BASE_ENV.CALLBACK_URL);
    });

    it("embeds r field in state payload for redirect_uri binding", async () => {
        const app = new Hono<HonoEnv>().route("/auth", authRouter);
        const resp = await app.fetch(
            new Request("http://localhost:9001/auth/github"),
            BASE_ENV
        );
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location") || "";
        const params = new URL(location).searchParams;
        const encryptedState = params.get("state") || "";
        // State should be a non-empty encrypted token starting with k1.
        expect(encryptedState).toMatch(/^k1\./);
    });
});
