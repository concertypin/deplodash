import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { userRouter } from "@/routes/user";
import { registerAgentToken, verifyAgentToken } from "@/middleware/agent-auth";
import { env } from "cloudflare:workers";

const tokenItemSchema = z.object({
    token: z.string(),
    agent_id: z.string(),
    label: z.string(),
    created_at: z.string(),
});

const listResponseSchema = z.object({
    status: z.literal("ok"),
    tokens: z.array(tokenItemSchema),
});

const createResponseSchema = z.object({
    status: z.literal("ok"),
    token: z.string(),
    info: z.object({
        agent_id: z.string(),
        label: z.string(),
        created_at: z.string(),
        created_by: z.string(),
    }),
});

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
};

function makeApp(overrides?: Partial<HonoEnv["Bindings"]>) {
    const authEnv: HonoEnv["Bindings"] = {
        ...BASE_ENV,
        GITHUB_TOKEN: "ghp_test_user_token",
        ...overrides,
    };
    const app = new Hono<HonoEnv>().route("/api/user", userRouter);
    return { app, authEnv };
}

describe("User agent token management", () => {
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

    describe("GET /api/user/agent/list", () => {
        it("returns 401 when not authenticated", async () => {
            const app = new Hono<HonoEnv>().route("/api/user", userRouter);
            const resp = await app.request(
                "/api/user/agent/list",
                undefined,
                BASE_ENV
            );
            expect(resp.status).toBe(401);
        });

        it("returns empty list when user has no agent tokens", async () => {
            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/list",
                undefined,
                authEnv
            );
            expect(resp.status).toBe(200);
            const body = listResponseSchema.parse(await resp.json());
            expect(body.tokens).toHaveLength(0);
        });

        it("returns only the user's own tokens", async () => {
            await registerAgentToken(
                env.KV,
                "user-token-1",
                "agent-alpha",
                "Agent Alpha",
                "testuser"
            );
            await registerAgentToken(
                env.KV,
                "user-token-2",
                "agent-beta",
                "Agent Beta",
                "anotheruser"
            );
            await registerAgentToken(
                env.KV,
                "user-token-3",
                "agent-gamma",
                undefined,
                "testuser"
            );

            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/list",
                undefined,
                authEnv
            );
            expect(resp.status).toBe(200);
            const body = listResponseSchema.parse(await resp.json());
            expect(body.tokens).toHaveLength(2);
            const agentIds = body.tokens.map((t) => t.agent_id);
            expect(agentIds).toContain("agent-alpha");
            expect(agentIds).toContain("agent-gamma");
            expect(agentIds).not.toContain("agent-beta");

            for (const token of body.tokens) {
                expect(token.token).toBeTypeOf("string");
                expect(token.agent_id).toBeTypeOf("string");
                expect(token.label).toBeTypeOf("string");
                expect(token.created_at).toBeTypeOf("string");
            }
        });
    });

    describe("POST /api/user/agent/create", () => {
        it("returns 401 when not authenticated", async () => {
            const app = new Hono<HonoEnv>().route("/api/user", userRouter);
            const resp = await app.request(
                "/api/user/agent/create",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ agent_id: "new-agent" }),
                },
                BASE_ENV
            );
            expect(resp.status).toBe(401);
        });

        it("creates a new agent token for the user", async () => {
            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/create",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        agent_id: "new-agent",
                        label: "My New Agent",
                    }),
                },
                authEnv
            );
            expect(resp.status).toBe(200);
            const body = createResponseSchema.parse(await resp.json());
            expect(body.token.length).toBeGreaterThan(0);
            expect(body.info.agent_id).toBe("new-agent");
            expect(body.info.label).toBe("My New Agent");
            expect(body.info.created_by).toBe("testuser");

            const verified = await verifyAgentToken(env.KV, body.token);
            expect(verified).not.toBeNull();
            expect(verified!.agent_id).toBe("new-agent");
            expect(verified!.created_by).toBe("testuser");
        });

        it("creates a token with default label when none provided", async () => {
            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/create",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ agent_id: "minimal-agent" }),
                },
                authEnv
            );
            expect(resp.status).toBe(200);
            const body = createResponseSchema.parse(await resp.json());
            expect(body.info.label).toBe("minimal-agent");
        });

        it("rejects empty agent_id", async () => {
            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/create",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ agent_id: "" }),
                },
                authEnv
            );
            expect(resp.status).toBe(400);
        });
    });

    describe("POST /api/user/agent/revoke", () => {
        it("returns 401 when not authenticated", async () => {
            const app = new Hono<HonoEnv>().route("/api/user", userRouter);
            const resp = await app.request(
                "/api/user/agent/revoke",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: "some-token" }),
                },
                BASE_ENV
            );
            expect(resp.status).toBe(401);
        });

        it("revokes user's own token", async () => {
            await registerAgentToken(
                env.KV,
                "token-to-revoke",
                "revocable-agent",
                "Revocable",
                "testuser"
            );

            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/revoke",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: "token-to-revoke" }),
                },
                authEnv
            );
            expect(resp.status).toBe(200);
            const body = await resp.json();
            expect(body).toEqual({ status: "ok" });

            const verified = await verifyAgentToken(env.KV, "token-to-revoke");
            expect(verified).toBeNull();
        });

        it("returns 403 when trying to revoke another user's token", async () => {
            await registerAgentToken(
                env.KV,
                "other-user-token",
                "other-agent",
                "Other",
                "anotheruser"
            );

            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/revoke",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: "other-user-token" }),
                },
                authEnv
            );
            expect(resp.status).toBe(403);

            const verified = await verifyAgentToken(env.KV, "other-user-token");
            expect(verified).not.toBeNull();
        });

        it("returns 403 for non-existent token", async () => {
            const { app, authEnv } = makeApp();
            const resp = await app.request(
                "/api/user/agent/revoke",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: "nonexistent-token" }),
                },
                authEnv
            );
            expect(resp.status).toBe(403);
        });
    });
});
