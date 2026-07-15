/**
 * Admin agent revoke endpoint tests.
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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob", BASE_ENV)
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
            adminEnv("admin-bob", BASE_ENV)
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid JSON body");
    });

    it("returns 200 and revokes token when admin", async () => {
        mockGitHubUser("admin-bob");

        await registerAgentToken(
            BASE_ENV.KV,
            "revocable-token",
            "revocable-agent",
            "To Be Revoked"
        );

        const { verifyAgentToken } = await import("@/middleware/agent-auth");
        expect(
            await verifyAgentToken(BASE_ENV.KV, "revocable-token")
        ).not.toBeNull();

        const { app } = createAdminApp();
        const cookie = await encryptSessionCookie("ghp_admin_token");
        const resp = await app.fetch(
            new Request("http://localhost/api/admin/agent/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/json", Cookie: cookie },
                body: JSON.stringify({ token: "revocable-token" }),
            }),
            adminEnv("admin-bob", BASE_ENV)
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");

        expect(
            await verifyAgentToken(BASE_ENV.KV, "revocable-token")
        ).toBeNull();
    });
});
