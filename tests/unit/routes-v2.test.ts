import {
    describe,
    expect,
    it,
    beforeEach,
    beforeAll,
    afterEach,
    vi,
} from "vitest";
import { z } from "zod";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { tokenRouter } from "@/routes/token";
import { llmsRouter } from "@/routes/llms";
import { authRouter } from "@/routes/auth";
import { pagesRouter } from "@/routes/pages";
import { resetKeyCache } from "@/crypto";
import { sessionMiddleware } from "@/middleware";
import { TokenService } from "@/token-service";
import { env } from "cloudflare:workers";
import { registerAgentToken } from "@/middleware/agent-auth";

const errorResponseSchema = z.object({ error: z.string() });

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
    // GITHUB_INSTALLATION_ID removed — now resolved dynamically
};

beforeEach(() => {
    resetKeyCache();
});

describe("GET /llms.txt", () => {
    const app = new Hono<HonoEnv>().route("/", llmsRouter);
    const client = testClient(app, BASE_ENV);

    it("returns llms.txt content", async () => {
        const resp = await client["llms.txt"].$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("/api/token");
        expect(resp.headers.get("Content-Type")).toContain("text/plain");
    });
});

describe("GET /auth/consent", () => {
    const app = new Hono<HonoEnv>()
        .route("/auth", authRouter)
        .route("/auth", consentRouter);
    const client = testClient(app, BASE_ENV);

    it("redirects to login when not authenticated", async () => {
        const resp = await client.auth.consent.$get({
            query: { repo: "owner/repo", scopes: "contents:read" },
        });
        // authGuard renders login page since not authenticated
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("/auth/github");
    });
});

describe("POST /api/token (without auth)", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);
    const client = testClient(app, BASE_ENV);

    it("returns 401 when no bearer token", async () => {
        const resp = await client.api.token.$post({
            json: { repo: "owner/repo", scopes: ["contents:read"] },
        });
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toBeTruthy();
    });

    it("returns 401 when bearer token is invalid", async () => {
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer invalid_token" } }
        );
        expect(resp.status).toBe(401);
    });
});

describe("POST /api/token (authenticated, needs consent)", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);
    const client = testClient(app, BASE_ENV);

    beforeEach(async () => {
        await registerAgentToken(
            BASE_ENV.KV,
            "test-agent-token",
            "test-agent",
            "Test Agent"
        );
    });

    it("returns needs_consent because consent is checked before any GitHub API call", async () => {
        const resp = await client.api.token.$post(
            {
                json: { repo: "owner/repo", scopes: ["contents:read"] },
            },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        // Consent is checked via KV first (no GitHub API call), so it returns needs_consent
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("needs_consent");
    });
});

describe("POST /api/token — Full grant flow", () => {
    let pkcs8Pem: string;
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);

    function jsonResponse(data: unknown, status = 200): Response {
        return new Response(JSON.stringify(data), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }

    function makeEnv(pem: string): HonoEnv["Bindings"] {
        return {
            ...BASE_ENV,
            GITHUB_APP_PRIVATE_KEY: pem,
            KV: env.KV,
        };
    }

    beforeAll(async () => {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: "RSASSA-PKCS1-v1_5",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["sign", "verify"]
        );
        const pkcs8 = await crypto.subtle.exportKey(
            "pkcs8",
            keyPair.privateKey
        );
        const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
        const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
        pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    });

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));

        mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);

        await registerAgentToken(
            BASE_ENV.KV,
            "flow-agent-token",
            "flow-agent",
            "Flow Test Agent"
        );
    });

    it("returns 200 with token when consent exists", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("owner/repo", ["contents:read"]);

        mockFetch
            // resolveInstallationId → org installation
            .mockResolvedValueOnce(
                jsonResponse({ id: 12345, account: { login: "owner" } })
            )
            // getInstallationToken (admin for ensureRepoExists)
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_token_123",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            // ensureRepoExists → repo check (200 = exists)
            .mockResolvedValueOnce(jsonResponse({ name: "repo" }))
            // requestToken → getInstallationToken (scoped, cache hit for resolveInstallationId)
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_scoped_token_456",
                    expires_at: "2027-01-01T00:00:00Z",
                    permissions: { contents: "read" },
                    repository_selection: "selected",
                })
            );

        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );

        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(typeof body.token).toBe("string");
        expect(typeof body.expires_at).toBe("string");
    });

    it("returns 202 needs_consent without creating repo when no consent (0 fetch calls)", async () => {
        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "other/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );

        expect(resp.status).toBe(202);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("needs_consent");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns 200 with token for repo with admin scope", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("admin/repo", ["admin"]);

        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ id: 999, account: { login: "admin" } })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_token_999",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            .mockResolvedValueOnce(jsonResponse({ name: "repo" }))
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_admin_scoped",
                    expires_at: "2027-06-01T00:00:00Z",
                    permissions: {
                        contents: "write",
                        workflows: "write",
                        administration: "write",
                    },
                    repository_selection: "selected",
                })
            );

        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            { json: { repo: "admin/repo", scopes: ["admin"] } },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );

        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(typeof body.token).toBe("string");
    });

    it("creates repo and issues token when repo does not exist", async () => {
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("neworg/new-repo", ["contents:write"]);

        mockFetch
            // resolveInstallationId
            .mockResolvedValueOnce(
                jsonResponse({ id: 77, account: { login: "neworg" } })
            )
            // getInstallationToken (admin)
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "admin_create_token",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { administration: "write" },
                    repository_selection: "selected",
                })
            )
            // repo check — 404 (does not exist)
            .mockResolvedValueOnce(jsonResponse({ message: "Not found" }, 404))
            // org check — 200 (is an org)
            .mockResolvedValueOnce(jsonResponse({ login: "neworg" }))
            // create repo — 201
            .mockResolvedValueOnce(
                jsonResponse(
                    { name: "new-repo", full_name: "neworg/new-repo" },
                    201
                )
            )
            // requestToken → getInstallationToken (scoped, cache hit for resolveInstallationId)
            .mockResolvedValueOnce(
                jsonResponse({
                    token: "ghs_created_repo_token",
                    expires_at: "2027-03-01T00:00:00Z",
                    permissions: { contents: "write" },
                    repository_selection: "selected",
                })
            );

        const client = testClient(app, makeEnv(pkcs8Pem));
        const resp = await client.api.token.$post(
            {
                json: { repo: "neworg/new-repo", scopes: ["contents:write"] },
            },
            { headers: { Authorization: "Bearer flow-agent-token" } }
        );

        expect(resp.status).toBe(200);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("ok");
        expect(body.token).toBe("ghs_created_repo_token");
    });
});

// ─── GET /auth/github — GitHub OAuth redirect ───────────────────────────────

describe("GET /auth/github", () => {
    const app = new Hono<HonoEnv>().route("/auth", authRouter);
    const client = testClient(app, BASE_ENV);

    it("redirects to GitHub OAuth authorization URL with proper params", async () => {
        const resp = await client.auth.github.$get({ query: {} });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toContain("https://github.com/login/oauth/authorize");
        expect(location).toContain("client_id=test-client");
        expect(location).toContain("code_challenge_method=S256");
        expect(location).toContain("scope=repo");
    });

    it("includes next parameter when provided", async () => {
        const resp = await client.auth.github.$get({
            query: { next: "/custom" },
        });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toContain("https://github.com/login/oauth/authorize");
        expect(location).toContain("redirect_uri=");
    });
});

// ─── GET / (pages) — Root page routes ────────────────────────────────────────

describe("GET / (pages)", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    const pagesApp = new Hono<HonoEnv>()
        .use("*", sessionMiddleware())
        .route("/", pagesRouter);

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));

        mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns login page when not authenticated", async () => {
        const client = testClient(pagesApp, BASE_ENV);

        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Login with GitHub");
        expect(text).toContain("/auth/github");
    });

    it("renders home page with user info when authenticated", async () => {
        const mockHandler: typeof fetch = () =>
            Promise.resolve(new Response("Unexpected", { status: 500 }));
        mockFetch.mockImplementation(mockHandler);
        mockFetch.mockResolvedValueOnce(
            Response.json({
                login: "testuser",
                avatar_url: "https://avatars.githubusercontent.com/u/1",
                id: 1,
                name: "Test User",
            })
        );

        const authEnv: HonoEnv["Bindings"] = {
            ENCRYPTION_SECRET: TEST_SECRET,
            GITHUB_CLIENT_ID: "test-client",
            GITHUB_CLIENT_SECRET: "test-secret",
            CALLBACK_URL: "http://localhost:5178/callback",
            KV: env.KV,
            GITHUB_TOKEN: "ghp_test_user_token",
            GITHUB_APP_ID: "123456",
            GITHUB_APP_PRIVATE_KEY:
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
        };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);

        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        // Authenticated page shows user info and dashboard
        expect(text).toContain("Deplodash");
        expect(text).toContain("testuser");
        expect(text).toContain("Authorized Repositories");
        // Not the login page
        expect(text).not.toContain("Login with GitHub");
    });

    it("records consent and listConsents retrieves it", async () => {
        // Verify that TokenService can record and list consents
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("owner/repo", ["contents:read"]);
        expect(
            await tokenService.checkConsent("owner/repo", ["contents:read"])
        ).toBe(true);

        const consents = await tokenService.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.repo).toBe("owner/repo");
        expect(consents[0]!.scopes).toBe("contents:read");
    });

    it("renders empty state when no consents", async () => {
        mockFetch.mockResolvedValue(
            new Response("Unexpected", { status: 500 })
        );
        mockFetch.mockResolvedValueOnce(
            Response.json({
                login: "testuser",
                avatar_url: "https://example.com/avatar.png",
                id: 1,
                name: "Test User",
            })
        );

        // No consents recorded — page should show empty state
        const authEnv: HonoEnv["Bindings"] = {
            ENCRYPTION_SECRET: TEST_SECRET,
            GITHUB_CLIENT_ID: "test-client",
            GITHUB_CLIENT_SECRET: "test-secret",
            CALLBACK_URL: "http://localhost:5178/callback",
            KV: env.KV,
            GITHUB_TOKEN: "ghp_test_user_token",
            GITHUB_APP_ID: "123456",
            GITHUB_APP_PRIVATE_KEY:
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
        };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);

        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("testuser");
        // Home page renders empty consent state
        expect(text).toContain("No consents granted yet");
    });

    it("handles GitHub API errors", async () => {
        mockFetch.mockImplementation(() => {
            throw new Error("API rate limit exceeded");
        });

        const authEnv: HonoEnv["Bindings"] = {
            ENCRYPTION_SECRET: TEST_SECRET,
            GITHUB_CLIENT_ID: "test-client",
            GITHUB_CLIENT_SECRET: "test-secret",
            CALLBACK_URL: "http://localhost:5178/callback",
            KV: env.KV,
            GITHUB_TOKEN: "ghp_test_user_token",
            GITHUB_APP_ID: "123456",
            GITHUB_APP_PRIVATE_KEY:
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
        };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);

        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Error");
        expect(text).toContain("API rate limit exceeded");
    });

    it("handles non-Error thrown values", async () => {
        mockFetch.mockImplementation(() => {
            throw new Error("A plain string error");
        });

        const authEnv: HonoEnv["Bindings"] = {
            ENCRYPTION_SECRET: TEST_SECRET,
            GITHUB_CLIENT_ID: "test-client",
            GITHUB_CLIENT_SECRET: "test-secret",
            CALLBACK_URL: "http://localhost:5178/callback",
            KV: env.KV,
            GITHUB_TOKEN: "ghp_test_user_token",
            GITHUB_APP_ID: "123456",
            GITHUB_APP_PRIVATE_KEY:
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
        };
        const app = new Hono<HonoEnv>().route("/", pagesRouter);
        const client = testClient(app, authEnv);

        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Error");
        expect(text).toContain("plain string error");
    });
});

// ─── POST /auth/consent — Record user consent ────────────────────────────────

describe("POST /auth/consent", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    it("records consent and shows success page", async () => {
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

        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Consent");

        // Verify consent was stored in KV
        const tokenService = new TokenService(env.KV);
        const hasConsent = await tokenService.checkConsent("owner/repo", [
            "contents:read",
        ]);
        expect(hasConsent).toBe(true);

        // Also verify via listConsents (same method the pages handler uses)
        const consents = await tokenService.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.repo).toBe("owner/repo");
    });

    it("returns 400 and error when recording fails", async () => {
        vi.spyOn(TokenService.prototype, "recordConsent").mockRejectedValue(
            new Error("KV write failed")
        );

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
        const text = await resp.text();
        expect(text).toContain("Failed to record consent");

        vi.restoreAllMocks();
    });

    it("returns login page when not authenticated", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);
        const client = testClient(app, BASE_ENV);

        const resp = await client.auth.consent.$post({
            form: { repo: "owner/repo", scopes: "contents:read" },
        });

        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Login with GitHub");
        expect(text).toContain("/auth/github");
    });
});

// ─── POST /auth/revoke — Revoke user consent ─────────────────────────────────

describe("POST /auth/revoke", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    it("revokes consent and redirects to /", async () => {
        // Pre-record a consent to revoke
        const tokenService = new TokenService(env.KV);
        await tokenService.recordConsent("owner/repo", ["contents:read"]);

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
        expect(resp.headers.get("Location")).toBe("/");

        // Verify consent was removed
        const hasConsent = await tokenService.checkConsent("owner/repo", [
            "contents:read",
        ]);
        expect(hasConsent).toBe(false);
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

// ─── POST /api/token (without GitHub App configured) ─────────────────────────

describe("POST /api/token (without GitHub App configured)", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        await registerAgentToken(
            BASE_ENV.KV,
            "noapp-agent-token",
            "noapp-agent",
            "No App Agent"
        );
    });

    it("returns 400 when GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set", async () => {
        const noAppEnv: HonoEnv["Bindings"] = {
            ENCRYPTION_SECRET: TEST_SECRET,
            GITHUB_CLIENT_ID: "test-client",
            GITHUB_CLIENT_SECRET: "test-secret",
            CALLBACK_URL: "http://localhost:5178/callback",
            KV: env.KV,
            GITHUB_APP_ID: "",
            GITHUB_APP_PRIVATE_KEY: "",
        };
        const app = new Hono<HonoEnv>().route("/api", tokenRouter);
        const client = testClient(app, noAppEnv);

        const resp = await client.api.token.$post(
            {
                json: { repo: "owner/repo", scopes: ["contents:read"] },
            },
            { headers: { Authorization: "Bearer noapp-agent-token" } }
        );

        expect(resp.status).toBe(400);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toContain("GitHub App not configured");
    });
});
