import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { TEST_SECRET } from "../../helpers";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { resetKeyCache } from "@/crypto";
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

    it("rejects consent with scopes not in original request", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        // First GET to obtain a valid encrypted payload scoped to "contents:read"
        const getResp = await app.fetch(
            new Request(
                "http://localhost/auth/consent?repo=owner/repo&scopes=contents:read&agent_id=test-agent"
            ),
            authEnv
        );
        const getText = await getResp.text();
        const encMatch = getText.match(
            /name="requested_scopes_enc" value="([^"]+)"/
        );
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        // Attempt to approve "admin" when original request was "contents:read"
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "admin",
                    agent_id: "test-agent",
                    requested_scopes_enc: encryptedValue,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain(
            "Cannot approve scopes not in the original request"
        );
    });

    it("rejects encrypted context cross-repo replay attack", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const getResp = await app.fetch(
            new Request(
                "http://localhost/auth/consent?repo=victim/repo&scopes=contents:read&agent_id=agent-a"
            ),
            authEnv
        );
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();
        const encMatch = getText.match(
            /name="requested_scopes_enc" value="([^"]+)"/
        );
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "attacker/repo",
                    scopes: "contents:read",
                    agent_id: "agent-a",
                    requested_scopes_enc: encryptedValue,
                }),
            }),
            authEnv
        );
        expect(postResp.status).toBe(400);
        expect(await postResp.text()).toContain("Invalid consent request");
    });

    it("rejects encrypted context cross-agent replay attack", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const getResp = await app.fetch(
            new Request(
                "http://localhost/auth/consent?repo=shared/repo&scopes=contents:read&agent_id=agent-a"
            ),
            authEnv
        );
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();
        const encMatch = getText.match(
            /name="requested_scopes_enc" value="([^"]+)"/
        );
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "shared/repo",
                    scopes: "contents:read",
                    agent_id: "agent-b",
                    requested_scopes_enc: encryptedValue,
                }),
            }),
            authEnv
        );
        expect(postResp.status).toBe(400);
        expect(await postResp.text()).toContain("Invalid consent request");
    });

    it("rejects POST without requested_scopes_enc when ENCRYPTION_SECRET is configured", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "contents:read",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Invalid consent request");
    });

    it("rejects tampered encrypted context value", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: "AAAA.BBBa5nRhaW5lZFN0cmluZw.CCC.DDD",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Invalid consent request");
    });
});
