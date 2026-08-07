import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TEST_SECRET, contains } from "@tests/helpers";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { TokenService } from "@/token/service";
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

describe("POST /api/consent", () => {
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

    /** Helper: POST /api/consent with direct consent parameters. */
    async function consentPost(
        body: Record<string, unknown>,
        overrides?: Partial<HonoEnv["Bindings"]>
    ): Promise<Response> {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
            ...overrides,
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        return app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            authEnv
        );
    }

    it("records consent and returns status ok", async () => {
        const resp = await consentPost({
            repo: "testuser/repo",
            scopes: "contents:read",
            agent_id: "test-agent",
        });
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body).toEqual({ status: "ok" });
        const tokenService = new TokenService(env.KV);
        expect(
            await tokenService.checkConsent("test-agent", "testuser/repo", [
                "contents:read",
            ])
        ).toBe(true);
    });

    it("creates a missing personal repository with the OAuth user token", async () => {
        mockFetch
            .mockResolvedValueOnce(
                Response.json({
                    login: "testuser",
                    id: 1,
                    avatar_url: "",
                    name: "Test User",
                })
            )
            .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
            .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
            .mockResolvedValueOnce(
                Response.json(
                    { full_name: "testuser/new-repo" },
                    { status: 201 }
                )
            );

        const resp = await consentPost({
            repo: "testuser/new-repo",
            scopes: "contents:write",
            agent_id: "test-agent",
            repo_mode: "create-if-missing",
        });

        expect(resp.status).toBe(200);
        expect(mockFetch).toHaveBeenNthCalledWith(
            4,
            "https://api.github.com/user/repos",
            expect.objectContaining({
                method: "POST",
            })
        );
    });

    it("returns 500 when recording fails", async () => {
        vi.spyOn(TokenService.prototype, "recordConsent").mockRejectedValue(
            new Error("KV write failed")
        );
        const resp = await consentPost({
            repo: "testuser/repo",
            scopes: "contents:read",
            agent_id: "test-agent",
        });
        expect(resp.status).toBe(500);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("KV write failed");
        vi.restoreAllMocks();
    });

    it("returns 401 when not authenticated", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    agent_id: "test-agent",
                    scopes: "contents:read",
                    repo_mode: "existing-only",
                }),
            }),
            BASE_ENV
        );
        expect(resp.status).toBe(401);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Not authenticated");
    });

    it("rejects consent when the repository is missing", async () => {
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
                    agent_id: "test-agent",
                    scopes: "contents:read",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
    });

    it("accepts admin compound scope by expanding into granular scopes", async () => {
        const resp = await consentPost({
            repo: "testuser/repo",
            agent_id: "test-agent",
            scopes: "admin",
            repo_mode: "existing-only",
        });

        // admin gets expanded to granular scopes before validation,
        // so it passes both APPROVABLE_SCOPES and subset checks.
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    it("accepts direct subset approval with multi-scope request", async () => {
        const resp = await consentPost({
            repo: "testuser/repo",
            agent_id: "test-agent",
            scopes: "contents:read",
            repo_mode: "existing-only",
        });
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    // ── Repository authority verification ────────────────────────────────────

    it("rejects consent when user lacks admin authority on a different owner's repo", async () => {
        const resp = await consentPost({
            repo: "other-owner/repo",
            agent_id: "test-agent",
            scopes: "contents:read",
            repo_mode: "existing-only",
        });
        expect(resp.status).toBe(403);
    });

    it("accepts consent when user owns the target namespace (username matches repo owner)", async () => {
        const resp = await consentPost({
            repo: "testuser/my-repo",
            scopes: "contents:read",
            agent_id: "test-agent",
        });
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    it("accepts a mixed-case personal-owner repository", async () => {
        const resp = await consentPost({
            repo: "TestUser/my-repo",
            scopes: "contents:read",
            agent_id: "test-agent",
        });
        expect(resp.status).toBe(200);
    });

    it("accepts direct consent with mixed-case repository identity", async () => {
        const resp = await consentPost({
            repo: "TestUser/My-Repo",
            agent_id: "test-agent",
            scopes: "contents:read",
            repo_mode: "existing-only",
        });
        expect(resp.status).toBe(200);
        const tokenService = new TokenService(env.KV);
        expect(
            await tokenService.checkConsent("test-agent", "TestUser/My-Repo", [
                "contents:read",
            ])
        ).toBe(true);
    });

    it("finds consent recorded with different repo casing on retry", async () => {
        // Consent is recorded under "TestUser/My-Repo"; the agent retries
        // with "testuser/my-repo". GitHub repo identity is case-insensitive,
        // so the retry must still find the stored grant.
        const grant = await consentPost({
            repo: "TestUser/My-Repo",
            agent_id: "test-agent",
            scopes: "contents:read",
            repo_mode: "existing-only",
        });
        expect(grant.status).toBe(200);

        const tokenService = new TokenService(env.KV);
        expect(
            await tokenService.checkConsent("test-agent", "testuser/my-repo", [
                "contents:read",
            ])
        ).toBe(true);
        expect(
            await tokenService.findConsentScopes(
                "test-agent",
                "testuser/my-repo",
                ["contents:read"]
            )
        ).toEqual(["contents:read"]);
    });

    it("accepts consent when user is a GitHub repo admin", async () => {
        // First call: GET /user returns testuser
        // Second call: GET /repos/org/repo returns admin: true
        mockFetch
            .mockResolvedValueOnce(
                Response.json({
                    login: "testuser",
                    id: 1,
                    avatar_url: "",
                    name: "Test User",
                })
            )
            .mockResolvedValueOnce(
                Response.json({ id: 1, permissions: { admin: true } })
            );

        const resp = await consentPost({
            repo: "org/repo",
            scopes: "contents:read",
            agent_id: "test-agent",
        });
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    it("accepts consent when user is an org admin", async () => {
        // First call: GET /user returns testuser
        // Second call: GET /repos/org/repo returns 404 (repo doesn't exist)
        // Third call: GET /orgs/org/memberships/testuser returns role=admin
        mockFetch
            .mockResolvedValueOnce(
                Response.json({
                    login: "testuser",
                    id: 1,
                    avatar_url: "",
                    name: "Test User",
                })
            )
            .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
            .mockResolvedValueOnce(
                Response.json({ role: "admin", state: "active" })
            );

        const resp = await consentPost({
            repo: "org/repo",
            agent_id: "test-agent",
            scopes: "contents:read",
            repo_mode: "existing-only",
        });
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });
});
