import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TEST_SECRET, contains } from "../../helpers";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { TokenService } from "@/token/service";
import { encryptWith, getOrInitKey, resetKeyCache } from "@/crypto";
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

    /** Generate an encrypted `requested_scopes_enc` payload with consent-request AAD. */
    async function encryptedPayload(data: {
        scopes: string;
        repo?: string;
        agent_id?: string;
    }): Promise<string> {
        const key = await getOrInitKey(TEST_SECRET);
        return encryptWith(
            key,
            JSON.stringify({
                version: 1,
                purpose: "consent-request",
                scopes: data.scopes,
                repo: data.repo ?? "testuser/repo",
                agent_id: data.agent_id ?? "test-agent",
            }),
            "consent-request"
        );
    }

    /** Helper: POST /api/consent with a valid encrypted payload. */
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

        const encValue =
            body.requested_scopes_enc ??
            (await encryptedPayload({
                scopes:
                    typeof body.scopes === "string"
                        ? body.scopes
                        : "contents:read",
                repo:
                    typeof body.repo === "string" ? body.repo : "testuser/repo",
                agent_id:
                    typeof body.agent_id === "string"
                        ? body.agent_id
                        : "test-agent",
            }));

        return app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...body,
                    requested_scopes_enc: encValue,
                }),
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
                    scopes: "contents:read",
                }),
            }),
            BASE_ENV
        );
        expect(resp.status).toBe(401);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toBe("Not authenticated");
    });

    it("rejects tampered encrypted requested_scopes", async () => {
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
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    requested_scopes_enc: "invalid.encrypted.value",
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid consent request");
    });

    it("accepts valid encrypted requested_scopes", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const encValue = await encryptedPayload({
            scopes: "contents:read",
            repo: "testuser/repo",
            agent_id: "test-agent",
        });

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: encValue,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    it("rejects unsupported compound scopes even when originally requested", async () => {
        const encValue = await encryptedPayload({
            scopes: "admin",
            repo: "testuser/repo",
            agent_id: "test-agent",
        });

        const resp = await consentPost({
            repo: "testuser/repo",
            scopes: "admin",
            agent_id: "test-agent",
            requested_scopes_enc: encValue,
        });

        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain(
            "Cannot approve unsupported scopes: admin"
        );
    });

    it("accepts subset approval with encrypted multi-scope request", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const encValue = await encryptedPayload({
            scopes: "contents:read,issues:write,administration:read",
            repo: "testuser/repo",
            agent_id: "test-agent",
        });

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: encValue,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    // ── DS-R01-C07: Cryptographic purpose separation & schema validation ──────

    it("rejects OAuth state payload replayed as consent request (AAD purpose separation)", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        // Encrypt with "oauth-state" AAD — the consent route expects "consent-request"
        const key = await getOrInitKey(TEST_SECRET);
        const oauthStateEnc = await encryptWith(
            key,
            JSON.stringify({
                v: "verifier",
                n: "/",
                r: "http://localhost/callback",
            }),
            "oauth-state"
        );

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: oauthStateEnc,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid consent request");
    });

    it("rejects encrypted payload missing version field", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(TEST_SECRET);
        const badPayload = await encryptWith(
            key,
            JSON.stringify({
                purpose: "consent-request",
                scopes: "contents:read",
                repo: "testuser/repo",
                agent_id: "test-agent",
            }),
            "consent-request"
        );

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: badPayload,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid consent request");
    });

    it("rejects encrypted payload with repo mismatch", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(TEST_SECRET);
        const mismatchPayload = await encryptWith(
            key,
            JSON.stringify({
                version: 1,
                purpose: "consent-request",
                scopes: "contents:read",
                repo: "other/repo",
                agent_id: "test-agent",
            }),
            "consent-request"
        );

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: mismatchPayload,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid consent request");
    });

    it("rejects encrypted payload with agent_id mismatch", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(TEST_SECRET);
        const mismatchPayload = await encryptWith(
            key,
            JSON.stringify({
                version: 1,
                purpose: "consent-request",
                scopes: "contents:read",
                repo: "testuser/repo",
                agent_id: "other-agent",
            }),
            "consent-request"
        );

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: mismatchPayload,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(400);
        const body = await resp.json();
        contains(body, "error");
        expect(body.error).toContain("Invalid consent request");
    });

    // ── DS-R01-C01: Repository authority verification ────────────────────────

    it("rejects consent when user lacks admin authority on a different owner's repo", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const encValue = await encryptedPayload({
            scopes: "contents:read",
            repo: "other-owner/repo",
            agent_id: "test-agent",
        });

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "other-owner/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: encValue,
                }),
            }),
            authEnv
        );
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

        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const encValue = await encryptedPayload({
            scopes: "contents:read",
            repo: "org/repo",
            agent_id: "test-agent",
        });

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "org/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: encValue,
                }),
            }),
            authEnv
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });
});
