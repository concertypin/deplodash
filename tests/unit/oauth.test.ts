import { describe, expect, it, beforeEach, vi } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { oauthRouter } from "@/routes/oauth";
import { authRouter } from "@/routes/auth";
import { env } from "cloudflare:workers";
import { resetKeyCache, getOrInitKey, encryptWith } from "@/crypto";
import { sessionMiddleware } from "@/middleware";

const TEST_SECRET = "test-secret-1234567890123456";
const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
} as HonoEnv["Bindings"];

beforeEach(() => {
    resetKeyCache();
});

describe("GET /callback", () => {
    const app = new Hono<HonoEnv>()
        .use("*", sessionMiddleware())
        .route("/", oauthRouter);
    const client = testClient(app, BASE_ENV);

    it("returns 400 when code and state are missing", async () => {
        const resp = await client.callback.$get();
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Missing code or state");
    });

    it("returns 400 when state is missing", async () => {
        const resp = await client.callback.$get({
            query: { code: "testcode" },
        });
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Missing code or state");
    });

    it("returns 400 when state is malformed (cannot decrypt)", async () => {
        const resp = await client.callback.$get({
            query: { code: "code", state: "invalid-state-no-dot" },
        });
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Invalid state");
    });

    it("returns 400 when state decrypts but is not valid JSON", async () => {
        const key = await getOrInitKey(TEST_SECRET);
        const encrypted = await encryptWith(key, "not-json");
        const resp = await client.callback.$get({
            query: { code: "code", state: encrypted },
        });
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Invalid state payload");
    });

    it("returns 400 when state payload is missing verifier", async () => {
        const key = await getOrInitKey(TEST_SECRET);
        const encrypted = await encryptWith(key, JSON.stringify({ n: "/" }));
        const resp = await client.callback.$get({
            query: { code: "code", state: encrypted },
        });
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Invalid state payload");
    });

    it("returns 400 on OAuth exchange failure", async () => {
        // Mock exchangeCode to fail
        const mockFetch = vi
            .fn<() => Promise<Response>>()
            .mockRejectedValue(new Error("Network error"));
        vi.stubGlobal("fetch", mockFetch);

        const key = await getOrInitKey(TEST_SECRET);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({ v: "verifier", n: "/" })
        );
        const resp = await client.callback.$get({
            query: { code: "bad-code", state: encrypted },
        });
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("OAuth failed");
    });

    it("redirects to /auth/github on TokenExpiredError", async () => {
        const { TokenExpiredError } = await import("@/errors");
        const mockFetch = vi
            .fn<() => Promise<Response>>()
            .mockRejectedValue(new TokenExpiredError());
        vi.stubGlobal("fetch", mockFetch);

        const key = await getOrInitKey(TEST_SECRET);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({ v: "verifier", n: "/" })
        );
        const resp = await client.callback.$get({
            query: { code: "code", state: encrypted },
        });
        expect(resp.status).toBe(302);
        expect(resp.headers.get("Location")).toBe("/auth/github");
    });

    it("successfully completes OAuth with valid code and state", async () => {
        const mockFetch = vi.fn<() => Promise<Response>>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    access_token: "gho_success_token",
                    token_type: "bearer",
                    scope: "repo,user",
                }),
                { headers: { "Content-Type": "application/json" } }
            )
        );
        vi.stubGlobal("fetch", mockFetch);

        const key = await getOrInitKey(TEST_SECRET);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({ v: "valid-verifier", n: "/dashboard" })
        );
        const resp = await client.callback.$get({
            query: { code: "valid-code", state: encrypted },
        });

        // Should redirect to the next URL with session cookie
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toBe("/dashboard");
        const setCookie = resp.headers.get("Set-Cookie") || "";
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("Max-Age=");
    });

    it("protects against open redirect via state payload", async () => {
        const mockFetch = vi.fn<() => Promise<Response>>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    access_token: "gho_token",
                    token_type: "bearer",
                    scope: "repo",
                }),
                { headers: { "Content-Type": "application/json" } }
            )
        );
        vi.stubGlobal("fetch", mockFetch);

        const key = await getOrInitKey(TEST_SECRET);
        // n contains an external URL — should be sanitized to /
        const encrypted = await encryptWith(
            key,
            JSON.stringify({ v: "verifier", n: "//evil.com" })
        );
        const resp = await client.callback.$get({
            query: { code: "code", state: encrypted },
        });

        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        // Unsafe redirect should be sanitized to /
        expect(location).toBe("/");
    });
});

describe("GET /logout", () => {
    const app = new Hono<HonoEnv>().route("/", oauthRouter);
    const client = testClient(app, BASE_ENV);

    it("clears session cookie and redirects to /", async () => {
        const resp = await client.logout.$get();
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toBe("/");
        const setCookie = resp.headers.get("Set-Cookie") || "";
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("Max-Age=0");
    });
});

describe("Full OAuth flow (integration)", () => {
    it("generates an encrypted state and starts OAuth", async () => {
        const app = new Hono<HonoEnv>().route("/auth", authRouter);
        const client = testClient(app, BASE_ENV);

        const resp = await client.auth.github.$get({ query: {} });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location") || "";
        expect(location).toContain("github.com/login/oauth/authorize");
        expect(location).toContain("state=");
        expect(location).toContain("code_challenge=");
    });
});
