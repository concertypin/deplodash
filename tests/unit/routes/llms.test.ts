import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { llmsRouter } from "@/routes/llms";
import { testClient } from "hono/testing";

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: new Proxy({} as KVNamespace, {
        get() {
            throw new Error(
                "KV binding not provided. Each test file must supply its own KV."
            );
        },
    }),
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    TOKEN_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
};

describe("GET /llms.txt", () => {
    const app = new Hono<HonoEnv>().route("/", llmsRouter);
    const client = testClient(app, BASE_ENV);

    it("returns llms.txt content", async () => {
        const resp = await client["llms.txt"].$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("/api/token");
        expect(text).toContain("/api/user/token");
        expect(text).toContain("effective_scopes");
        expect(resp.headers.get("Content-Type")).toContain("text/markdown");
    });
});
