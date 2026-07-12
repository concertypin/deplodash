import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { z } from "zod";

const errorResponseSchema = z.object({ error: z.string() });

const MIN_ENV = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
} satisfies HonoEnv["Bindings"];
describe("agentAuthMiddleware", () => {
    function createApp() {
        return new Hono<HonoEnv>().post(
            "/test",
            async (c, next) => {
                const { agentAuthMiddleware } =
                    await import("@/middleware/agent-auth");
                return agentAuthMiddleware()(c, next);
            },
            (c) => {
                const agentId = c.get("agent_id");
                return c.json({ agent_id: agentId });
            }
        );
    }

    beforeEach(async () => {
        // Clear KV
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });
    it("returns 401 when no Authorization header", async () => {
        const client = testClient(createApp(), MIN_ENV);
        const resp = await client.test.$post({});
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toContain("Missing");
    });
    it("returns 401 when token is not registered", async () => {
        const client = testClient(createApp(), MIN_ENV);
        const resp = await client.test.$post(
            {},
            { headers: { Authorization: "Bearer nonexistent-token" } }
        );
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toContain("Invalid");
    });
    it("returns 200 with agent_id when token is valid", async () => {
        const { registerAgentToken } = await import("@/middleware/agent-auth");
        await registerAgentToken(
            MIN_ENV.KV,
            "test-agent-token-123",
            "agent-42",
            "My Agent"
        );

        const client = testClient(createApp(), MIN_ENV);
        const resp = await client.test.$post(
            {},
            { headers: { Authorization: "Bearer test-agent-token-123" } }
        );
        expect(resp.status).toBe(200);
        const body = z
            .object({ agent_id: z.string() })
            .parse(await resp.json());
        expect(body.agent_id).toBe("agent-42");
    });
});

describe("registerAgentToken / revokeAgentToken / listAgentTokens", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    it("registers and lists agent tokens", async () => {
        const { registerAgentToken, listAgentTokens } =
            await import("@/middleware/agent-auth");

        await registerAgentToken(MIN_ENV.KV, "token-1", "agent-1", "Agent One");
        await registerAgentToken(MIN_ENV.KV, "token-2", "agent-2", "Agent Two");

        const tokens = await listAgentTokens(MIN_ENV.KV);
        expect(tokens).toHaveLength(2);
        const agentIds = tokens.map((t) => t.info.agent_id).sort();
        expect(agentIds).toEqual(["agent-1", "agent-2"]);
    });

    it("revokes an agent token", async () => {
        const { registerAgentToken, revokeAgentToken, verifyAgentToken } =
            await import("@/middleware/agent-auth");

        await registerAgentToken(
            MIN_ENV.KV,
            "token-revoke",
            "agent-revoke",
            "To Revoke"
        );
        expect(
            await verifyAgentToken(MIN_ENV.KV, "token-revoke")
        ).not.toBeNull();

        await revokeAgentToken(MIN_ENV.KV, "token-revoke");
        expect(await verifyAgentToken(MIN_ENV.KV, "token-revoke")).toBeNull();
    });

    it("returns empty list when no tokens exist", async () => {
        const { listAgentTokens } = await import("@/middleware/agent-auth");
        const tokens = await listAgentTokens(MIN_ENV.KV);
        expect(tokens).toEqual([]);
    });

    it("skips malformed entries in listAgentTokens", async () => {
        const { registerAgentToken, listAgentTokens } =
            await import("@/middleware/agent-auth");

        // Insert an entry with invalid schema (valid JSON but missing required fields)
        await MIN_ENV.KV.put(
            "agent_tokens:bad",
            JSON.stringify({ some_field: "not agent info" })
        );
        await registerAgentToken(
            MIN_ENV.KV,
            "good-token",
            "good-agent",
            "Good"
        );

        const tokens = await listAgentTokens(MIN_ENV.KV);
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.info.agent_id).toBe("good-agent");
    });
});

describe("verifyAgentToken", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    it("returns null for non-existent token", async () => {
        const { verifyAgentToken } = await import("@/middleware/agent-auth");
        const result = await verifyAgentToken(MIN_ENV.KV, "no-such-token");
        expect(result).toBeNull();
    });
});

describe("extractBearerToken", () => {
    it("handles missing Authorization header", async () => {
        const app = new Hono<HonoEnv>().post(
            "/test",
            async (c, next) => {
                const { agentAuthMiddleware } =
                    await import("@/middleware/agent-auth");
                return agentAuthMiddleware()(c, next);
            },
            (c) => c.json({ ok: true })
        );
        const client = testClient(app, MIN_ENV);

        const resp = await client.test.$post();
        expect(resp.status).toBe(401);
    });

    it("handles Bearer token without 'Bearer' prefix", async () => {
        const app = new Hono<HonoEnv>().post(
            "/test",
            async (c, next) => {
                const { agentAuthMiddleware } =
                    await import("@/middleware/agent-auth");
                return agentAuthMiddleware()(c, next);
            },
            (c) => c.json({ ok: true })
        );
        const client = testClient(app, MIN_ENV);

        const resp = await client.test.$post(
            {},
            { headers: { Authorization: "Token my-token" } }
        );
        expect(resp.status).toBe(401);
    });
});
