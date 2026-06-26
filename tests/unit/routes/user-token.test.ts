import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { userRouter } from "@/routes/user";
import { getOrInitKey, encryptWith } from "@/crypto";
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
};

describe("GET /api/user/token", () => {
    const KEY = "test-secret-1234567890123456";

    it("returns 401 when no session cookie", async () => {
        const app = new Hono<HonoEnv>().route("/api/user", userRouter);
        const resp = await app.request("/api/user/token", undefined, BASE_ENV);
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toBe("Not authenticated");
    });

    it("returns 401 when session cookie is malformed", async () => {
        const app = new Hono<HonoEnv>().route("/api/user", userRouter);
        const resp = await app.request("/api/user/token", { headers: { Cookie: "session=invalid-garbage" } }, BASE_ENV);
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toBe("Not authenticated");
    });

    it("returns user OAuth token when session cookie is valid", async () => {
        const app = new Hono<HonoEnv>().route("/api/user", userRouter);
        const key = await getOrInitKey(KEY);
        const encrypted = await encryptWith(key, "gho_test_user_token");
        const resp = await app.request("/api/user/token", { headers: { Cookie: `session=${encrypted}` } }, BASE_ENV);
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body).toEqual({ status: "ok", token: "gho_test_user_token" });
    });
});
