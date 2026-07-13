import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { TEST_SECRET } from "../../helpers";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { resetKeyCache, encryptWith, getOrInitKey } from "@/crypto";
import { env } from "cloudflare:workers";

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

describe("Consent Scope Validation (Scope Escalation Prevention)", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(async () => {
        resetKeyCache();
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));

        mockFetch = vi.fn<typeof fetch>();
        mockFetch.mockResolvedValue(
            Response.json({
                login: "testuser",
                id: 1,
                avatar_url: "",
                name: "Test User",
            })
        );
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("successfully grants consent with valid encrypted context", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(authEnv.ENCRYPTION_SECRET!);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({
                scopes: "contents:read",
                repo: "owner/repo",
                agent_id: "test-agent",
            })
        );

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: encrypted,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(200);
        const json = await resp.json();
        expect(json).toEqual({ status: "ok" });
    });

    it("rejects encrypted context cross-repo replay attack", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(authEnv.ENCRYPTION_SECRET!);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({
                scopes: "contents:read",
                repo: "victim/repo",
                agent_id: "agent-a",
            })
        );

        const postResp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "attacker/repo",
                    scopes: "contents:read",
                    agent_id: "agent-a",
                    requested_scopes_enc: encrypted,
                }),
            }),
            authEnv
        );
        expect(postResp.status).toBe(400);
        const json = await postResp.json();
        expect(json).toEqual({
            error: "Invalid consent request. Please try again from the agent's link.",
        });
    });

    it("rejects encrypted context cross-agent replay attack", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(authEnv.ENCRYPTION_SECRET!);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({
                scopes: "contents:read",
                repo: "shared/repo",
                agent_id: "agent-a",
            })
        );

        const postResp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "shared/repo",
                    scopes: "contents:read",
                    agent_id: "agent-b",
                    requested_scopes_enc: encrypted,
                }),
            }),
            authEnv
        );
        expect(postResp.status).toBe(400);
        const json = await postResp.json();
        expect(json).toEqual({
            error: "Invalid consent request. Please try again from the agent's link.",
        });
    });

    it("rejects POST without requested_scopes_enc when ENCRYPTION_SECRET is configured", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
                    scopes: "contents:read",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const json = await resp.json();
        expect(json).toEqual({
            error: "Invalid consent request. Missing encrypted payload.",
        });
    });

    it("rejects tampered encrypted context value", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: "AAAA.BBBa5nRhaW5lZFN0cmluZw.CCC.DDD",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const json = await resp.json();
        expect(json).toEqual({
            error: "Invalid consent request. Please try again from the agent's link.",
        });
    });
});
