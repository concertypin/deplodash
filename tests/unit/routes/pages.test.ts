import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { pagesRouter } from "@/routes/pages";
import { sessionMiddleware } from "@/middleware";
import { TokenService } from "@/token/service";
import { env } from "cloudflare:workers";

const TEST_SECRET = "test-secret-1234567890123456";

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
};

describe("GET / (pages)", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
    const pagesApp = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/", pagesRouter);

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it("returns login page when not authenticated", async () => {
        const client = testClient(pagesApp, BASE_ENV);
        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Login with GitHub");
        expect(text).toContain("/auth/github");
    });

    it("renders home page with user info when authenticated", async () => {
        mockFetch.mockResolvedValue(Response.json({ login: "testuser", avatar_url: "https://avatars.githubusercontent.com/u/1", id: 1, name: "Test User" }));
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);
        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("testuser");
        expect(text).not.toContain("Login with GitHub");
    });

    it("records consent and listConsents retrieves it", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "owner/repo", ["contents:read"]);
        expect(await tokenService.checkConsent("test-agent", "owner/repo", ["contents:read"])).toBe(true);
        const consents = await tokenService.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.repo).toBe("owner/repo");
    });

    it("renders empty state when no consents", async () => {
        mockFetch.mockResolvedValue(Response.json({ login: "testuser", avatar_url: "https://example.com/avatar.png", id: 1, name: "Test User" }));
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);
        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("No consents granted yet");
    });

    it("handles GitHub API errors", async () => {
        mockFetch.mockImplementation(() => { throw new Error("API rate limit exceeded"); });
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);
        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Error");
        expect(text).toContain("API rate limit exceeded");
    });
});
