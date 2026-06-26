/**
 * Admin agent list endpoint tests.
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

describe("GET /api/admin/agent/list — authentication", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    it("returns 401 when not authenticated", async () => {
        const { app } = createAdminApp();
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list"),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(401);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Not authenticated");
    });

    it("returns 403 when user is not in GITHUB_ADMIN_USERS", async () => {
        mockGitHubUser("testuser");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_user_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(403);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Forbidden");
    });

    it("returns 403 when GITHUB_ADMIN_USERS is empty", async () => {
        mockGitHubUser("testuser");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_user_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("")
        );
        expect(resp.status).toBe(403);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Forbidden");
    });

    it("returns 200 with token list when user is admin", async () => {
        await registerAgentToken(BASE_ENV.KV, "admin-token-1", "agent-alpha", "Alpha Agent");
        await registerAgentToken(BASE_ENV.KV, "admin-token-2", "agent-beta", "Beta Agent");

        mockGitHubUser("admin-bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
        contains(body, "tokens");
        expect(Array.isArray(body.tokens)).toBe(true);
        const agentIds = (body.tokens as Array<Record<string, unknown>>).map(
            (t: Record<string, unknown>) => t.agent_id
        );
        expect(agentIds).toContain("agent-alpha");
        expect(agentIds).toContain("agent-beta");
        for (const t of body.tokens as Array<Record<string, unknown>>) {
            expect(t).not.toHaveProperty("token");
        }
    });

    it("returns 403 when GitHub API call fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response("Unauthorized", { status: 401 })
            )
        );
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_bad_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("admin-bob")
        );
        expect(resp.status).toBe(403);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Failed to verify admin access");
    });

    it("is case-insensitive when matching admin usernames", async () => {
        mockGitHubUser("Admin-Bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("admin-bob,other-user")
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });
});
