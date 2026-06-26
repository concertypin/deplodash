import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { testClient } from "hono/testing";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { tokenRouter } from "@/routes/token";
import { resetKeyCache } from "@/crypto";
import { env } from "cloudflare:workers";

const errorResponseSchema = z.object({ error: z.string() });

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    TOKEN_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
};

beforeEach(() => { resetKeyCache(); });

describe("POST /api/token (without auth)", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);
    const client = testClient(app, BASE_ENV);

    it("returns 401 when no bearer token", async () => {
        const resp = await client.api.token.$post({ json: { repo: "owner/repo", scopes: ["contents:read"] } });
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
