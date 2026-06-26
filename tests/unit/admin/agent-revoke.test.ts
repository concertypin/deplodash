/**
 * Admin agent revoke endpoint tests.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { HonoEnv, SessionPayload } from "@/types";
import { adminRouter } from "@/routes/admin";
import { sessionMiddleware } from "@/middleware";
import { registerAgentToken } from "@/middleware/agent-auth";
import { resetKeyCache, getOrInitKey, encryptWith } from "@/crypto";
import { env } from "cloudflare:workers";
import { contains } from "../../helpers";

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
};

function createAdminApp(): { app: Hono<HonoEnv> } {
    const app = new Hono<HonoEnv>()
        .use("*", sessionMiddleware())
        .route("/api/admin", adminRouter);
    return { app };
}

async function encryptSessionCookie(ghToken: string): Promise<string> {
    const key = await getOrInitKey(TEST_SECRET);
    const payload: SessionPayload = {
        accessToken: ghToken,
        refreshToken: "dummy-refresh-token",
        accessExpiresAt: Date.now() + 3600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3600_000,
    };
    return `session=${await encryptWith(key, JSON.stringify(payload))}`;
}

function mockGitHubUser(login: string): void {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                login,
                id: 1,
                avatar_url: "",
                name: "Test User",
            })
        )
    );
}

function adminEnv(adminUsers: string): HonoEnv["Bindings"] {
    return { ...BASE_ENV, GITHUB_ADMIN_USERS: adminUsers };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
    resetKeyCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("POST /api/admin/agent/revoke — authentication", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    it("returns 401 when not authenticated", async () => {
        const { app } = createAdminApp();
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: "some-token" }),
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(401);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Not authenticated");
    });

    it("returns 403 when user is not admin", async () => {
        mockGitHubUser("testuser");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_user_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ token: "some-token" }),
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(403);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Forbidden");
    });

    it("returns 400 when token field is missing", async () => {
        mockGitHubUser("admin-bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({}),
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when token is an empty string", async () => {
        mockGitHubUser("admin-bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ token: "" }),
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when token is not a string", async () => {
        mockGitHubUser("admin-bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ token: 12345 }),
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Missing or invalid");
    });

    it("returns 400 when body is not JSON", async () => {
        mockGitHubUser("admin-bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "text/plain", Cookie: cookie },
                body: "not-json",
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid JSON body");
    });

    it("returns 200 and revokes token when admin", async () => {
        mockGitHubUser("admin-bob");

        await registerAgentToken(BASE_ENV.KV, "revocable-token", "revocable-agent", "To Be Revoked");

        const { verifyAgentToken } = await import("@/middleware/agent-auth");
        expect(await verifyAgentToken(BASE_ENV.KV, "revocable-token")).not.toBeNull();

        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ token: "revocable-token" }),
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");

        expect(await verifyAgentToken(BASE_ENV.KV, "revocable-token")).toBeNull();
    });
});
