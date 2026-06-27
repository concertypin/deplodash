import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TEST_SECRET } from "../../helpers";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { TokenService } from "@/token/service";
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

describe("POST /auth/revoke", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(async () => {
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

    it("revokes consent and redirects to /", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("test-agent", "owner/repo", [
            "contents:read",
        ]);
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/auth/revoke", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(302);
        expect(resp.headers.get("Location")).toBe("/");
        expect(
            await tokenService.checkConsent("test-agent", "owner/repo", [
                "contents:read",
            ])
        ).toBe(false);
    });

    it("redirects with error when revoking fails", async () => {
        vi.spyOn(TokenService.prototype, "revokeConsent").mockRejectedValue(
            new Error("KV delete failed")
        );
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/auth/revoke", {
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
        expect(resp.status).toBe(302);
        expect(resp.headers.get("Location")).toContain(
            "error=Failed+to+revoke+consent"
        );
        vi.restoreAllMocks();
    });
});
