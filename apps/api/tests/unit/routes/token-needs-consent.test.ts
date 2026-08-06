import { describe, expect, it, beforeEach, vi } from "vitest";
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

    it("returns needs_consent without exposing repository existence", async () => {
        const fetchSpy = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", fetchSpy);
        const resp = await client.api.token.$post(
            { json: { repo: "owner/repo", scopes: ["contents:read"] } },
            { headers: { Authorization: "Bearer test-agent-token" } }
        );
        expect(resp.status).toBe(202);
        const body = z.record(z.string(), z.unknown()).parse(await resp.json());
        expect(body.status).toBe("needs_consent");
        expect(body).not.toHaveProperty("repo_exists");
        expect(
            new URL(z.string().parse(body.url)).searchParams.has("repo_exists")
        ).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns a direct consent URL with request parameters", async () => {
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
        const body = z
            .object({
                status: z.literal("needs_consent"),
                url: z.string(),
                requested_scopes: z.array(z.string()).optional(),
                approved_scopes: z.array(z.string()).optional(),
            })
            .parse(await resp.json());
        const url = new URL(body.url);
        expect(url.searchParams.get("repo")).toBe("owner/repo");
        expect(url.searchParams.get("agent_id")).toBe("test-agent");
        expect(url.searchParams.get("scopes")).toBe(
            "contents:read,issues:write"
        );
        expect([...url.searchParams.keys()]).toEqual([
            "repo",
            "agent_id",
            "scopes",
            "repo_mode",
        ]);
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
            })
            .parse(await resp.json());
        const url = new URL(body.url);
        expect(url.searchParams.get("scopes")).toBe(
            "metadata:read,contents:write,workflows:write,administration:write"
        );
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
        expect(new URL(body.url).searchParams.get("scopes")).toBe(
            "metadata:read,contents:write,workflows:write"
        );
    });
});
