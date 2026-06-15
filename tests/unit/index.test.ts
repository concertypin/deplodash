import { describe, expect, it } from "vitest";
import { testClient } from "hono/testing";
import app from "@/index";
import type { HonoEnv } from "@/types";
import { env } from "cloudflare:workers";

const MIN_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
};

const client = testClient(app, MIN_ENV);

describe("index.ts - app configuration", () => {
    it("responds on root route", async () => {
        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
    });
});
