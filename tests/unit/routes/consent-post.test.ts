import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { TokenService } from "@/token/service";
import { resetKeyCache } from "@/crypto";
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

describe("POST /auth/consent", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(async () => {
        resetKeyCache();
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        mockFetch = vi.fn<typeof fetch>();
        mockFetch.mockResolvedValue(Response.json({ login: "testuser", id: 1, avatar_url: "", name: "Test User" }));
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it("records consent and shows success page", async () => {
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "contents:read", requested_scopes: "contents:read", agent_id: "test-agent" }),
            }), authEnv
        );
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Consent");
        const tokenService = new TokenService(env.KV);
        expect(await tokenService.checkConsent("test-agent", "owner/repo", ["contents:read"])).toBe(true);
    });

    it("returns 400 and error when recording fails", async () => {
        vi.spyOn(TokenService.prototype, "recordConsent").mockRejectedValue(new Error("KV write failed"));
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "contents:read", requested_scopes: "contents:read" }),
            }), authEnv
        );
        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain("Failed to record consent");
        vi.restoreAllMocks();
    });

    it("returns login page when not authenticated", async () => {
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const client = (await import("hono/testing")).testClient(app, BASE_ENV);
        const resp = await client.auth.consent.$post({ form: { repo: "owner/repo", scopes: "contents:read" } });
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Login with GitHub");
    });

    it("rejects scopes not in the original request (subset validation)", async () => {
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "admin", requested_scopes: "contents:read" }),
            }), authEnv
        );
        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain("Cannot approve scopes not in the original request");
    });

    it("rejects unknown scope strings", async () => {
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "bogus:scope", requested_scopes: "bogus:scope" }),
            }), authEnv
        );
        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain("Unknown scope");
    });

    it("rejects tampered encrypted requested_scopes", async () => {
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "contents:read", requested_scopes_enc: "invalid.encrypted.value" }),
            }), authEnv
        );
        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain("Invalid consent request");
    });

    it("accepts valid encrypted requested_scopes", async () => {
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const getResp = await app.fetch(new Request("http://localhost/auth/consent?repo=owner/repo&scopes=contents:read&agent_id=test-agent"), authEnv);
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();
        const encMatch = getText.match(/name="requested_scopes_enc" value="([^"]+)"/);
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "contents:read", agent_id: "test-agent", requested_scopes_enc: encryptedValue }),
            }), authEnv
        );
        expect(postResp.status).toBe(200);
        const text = await postResp.text();
        expect(text).toContain("Consent");
    });

    it("accepts subset approval with encrypted multi-scope request", async () => {
        const authEnv: HonoEnv["Bindings"] = { ...BASE_ENV, GITHUB_TOKEN: "ghp_test_user_token" };
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const getResp = await app.fetch(new Request("http://localhost/auth/consent?repo=owner/repo&scopes=contents:read,issues:write,admin&agent_id=test-agent"), authEnv);
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();
        const encMatch = getText.match(/name="requested_scopes_enc" value="([^"]+)"/);
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "contents:read", agent_id: "test-agent", requested_scopes_enc: encryptedValue }),
            }), authEnv
        );
        expect(postResp.status).toBe(200);
        const text = await postResp.text();
        expect(text).toContain("Consent");
    });
});
