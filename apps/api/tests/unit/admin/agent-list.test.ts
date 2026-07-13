/**
 * Admin agent list endpoint tests.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { contains, makeBaseEnv } from "../../helpers";
import {
    createAdminApp,
    encryptSessionCookie,
    mockGitHubUser,
    adminEnv,
    resetKeyCache,
} from "./helpers";
import { registerAgentToken } from "@/middleware/agent-auth";
import { env } from "cloudflare:workers";

const BASE_ENV = makeBaseEnv({ KV: env.KV });

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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("", BASE_ENV)
        );
        expect(resp.status).toBe(403);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Forbidden");
    });

    it("returns 200 with token list when user is admin", async () => {
        await registerAgentToken(
            BASE_ENV.KV,
            "admin-token-1",
            "agent-alpha",
            "Alpha Agent"
        );
        await registerAgentToken(
            BASE_ENV.KV,
            "admin-token-2",
            "agent-beta",
            "Beta Agent"
        );

        mockGitHubUser("admin-bob");
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("admin-bob", BASE_ENV)
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
            vi
                .fn<typeof fetch>()
                .mockResolvedValue(
                    new Response("Unauthorized", { status: 401 })
                )
        );
        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_bad_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/list", {
                headers: { Cookie: cookie },
            }),
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob,other-user", BASE_ENV)
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });
});
