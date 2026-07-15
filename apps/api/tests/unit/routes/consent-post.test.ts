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

    /** Generate an encrypted `requested_scopes_enc` payload. */
    async function encryptedPayload(data: {
        scopes: string;
        repo?: string;
        agent_id?: string;
    }): Promise<string> {
        const key = await getOrInitKey(TEST_SECRET);
        return encryptWith(key, JSON.stringify(data));
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
                scopes: (body.scopes as string) || "contents:read",
                repo: (body.repo as string) || "owner/repo",
                agent_id: (body.agent_id as string) || "test-agent",
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
            repo: "owner/repo",
            scopes: "contents:read",
            agent_id: "test-agent",
        });
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body).toEqual({ status: "ok" });
        const tokenService = new TokenService(env.KV);
        expect(
            await tokenService.checkConsent("test-agent", "owner/repo", [
                "contents:read",
            ])
        ).toBe(true);
    });

    it("returns 500 when recording fails", async () => {
        vi.spyOn(TokenService.prototype, "recordConsent").mockRejectedValue(
            new Error("KV write failed")
        );
        const resp = await consentPost({
            repo: "owner/repo",
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
                    repo: "owner/repo",
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
                    repo: "owner/repo",
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
            repo: "owner/repo",
            agent_id: "test-agent",
        });

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
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
            repo: "owner/repo",
            agent_id: "test-agent",
        });

        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
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
