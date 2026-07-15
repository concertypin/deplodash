import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { tokenRouter } from "@/routes/token";
import { env } from "cloudflare:workers";
import { registerAgentToken } from "@/middleware/agent-auth";

const errorResponseSchema = z.object({ error: z.string() });

describe("POST /api/token (without GitHub App configured)", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        await registerAgentToken(
            env.KV,
            "noapp-agent-token",
            "noapp-agent",
            "No App Agent"
        );
    });

    it("returns 400 when GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set", async () => {
        const noAppEnv: HonoEnv["Bindings"] = {
            ENCRYPTION_SECRET: "test-secret-1234567890123456",
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
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer noapp-agent-token" } }
        );
        expect(resp.status).toBe(500);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toContain("GitHub App not configured");
    });
});
