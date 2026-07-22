import { describe, expect, it, beforeEach } from "vitest";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import * as z from "zod";
import { tokenRouter } from "@/routes/token";
import { resetKeyCache } from "@/crypto";
import { env } from "cloudflare:workers";
import { registerAgentToken } from "@/middleware/agent-auth";

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    TOKEN_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
};

beforeEach(() => {
    resetKeyCache();
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
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.status).toBe("needs_consent");
    });

    it("returns consent URL with requested_scopes_enc and agent_id when ENCRYPTION_SECRET is configured", async () => {
        const resp = await client.api.token.$post(
            {
                json: {
                    repo: "owner/repo",
                    scopes: ["contents:read", "issues:write"],
                },
            },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        expect(resp.status).toBe(202);
        const needsConsentSchema = z.object({
            status: z.literal("needs_consent"),
            url: z.string(),
            requested_scopes_enc: z.string().optional(),
            requested_scopes: z.array(z.string()).optional(),
            approved_scopes: z.array(z.string()).optional(),
        });
        const body = needsConsentSchema.parse(await resp.json());
        expect(body.url).toContain("requested_scopes_enc=");
        expect(body.url).toContain("agent_id=test-agent");
        expect(body.requested_scopes_enc).toBeDefined();
    });

    it("expands compound admin scope into granular scopes in consent URL", async () => {
        const resp = await client.api.token.$post(
            {
                json: { repo: "owner/repo", scopes: ["admin"] },
            },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        expect(resp.status).toBe(202);
        const body = z
            .object({
                status: z.literal("needs_consent"),
                url: z.string(),
                requested_scopes: z.array(z.string()).optional(),
            })
            .parse(await resp.json());
        // URL should contain expanded granular scopes, not "admin"
        expect(body.url).not.toContain("scopes=admin");
        expect(body.url).toContain("administration%3Awrite");
        expect(body.url).toContain("contents%3Awrite");
        expect(body.url).toContain("workflows%3Awrite");
    });

    it("expands contents:write+workflows:write compound scope in consent URL", async () => {
        const resp = await client.api.token.$post(
            {
                json: {
                    repo: "owner/repo",
                    scopes: ["contents:write+workflows:write"],
                },
            },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        expect(resp.status).toBe(202);
        const body = z
            .object({
                status: z.literal("needs_consent"),
                url: z.string(),
            })
            .parse(await resp.json());
        // URL should contain expanded scopes, not the compound preset
        expect(body.url).not.toContain(
            "scopes=contents%3Awrite%2Bworkflows%3Awrite"
        );
        expect(body.url).toContain("contents%3Awrite");
        expect(body.url).toContain("workflows%3Awrite");
    });
});
