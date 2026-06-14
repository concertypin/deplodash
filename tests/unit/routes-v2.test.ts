import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { tokenRouter } from "@/routes/token";
import { llmsRouter } from "@/routes/llms";
import { authRouter } from "@/routes/auth";
import { resetKeyCache } from "@/crypto";
import { mockKVNamespace } from "../helpers";

const errorResponseSchema = z.object({ error: z.string() });

// ─── Test helpers ────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-1234567890123456";
const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: mockKVNamespace(),
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    GITHUB_INSTALLATION_ID: "654321",
};

beforeEach(() => {
    resetKeyCache();
});

describe("GET /llms.txt", () => {
    const app = new Hono<HonoEnv>().route("/", llmsRouter);

    it("returns llms.txt content", async () => {
        const resp = await app.request("/llms.txt", {}, BASE_ENV);
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("/api/token");
        expect(resp.headers.get("Content-Type")).toContain("text/plain");
    });
});

describe("GET /auth/consent", () => {
    const app = new Hono<HonoEnv>()
        .route("/auth", authRouter)
        .route("/auth", consentRouter);

    it("redirects to login when not authenticated", async () => {
        const resp = await app.request(
            "/auth/consent?repo=owner/repo&scopes=contents:read",
            {},
            BASE_ENV
        );
        // authGuard renders login page since not authenticated
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("/auth/github");
    });
});

describe("POST /api/token (without auth)", () => {
    const app = new Hono<HonoEnv>().route("/api", tokenRouter);

    it("returns 401 when no bearer token", async () => {
        const resp = await app.request(
            "/api/token",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                }),
            },
            BASE_ENV
        );
        expect(resp.status).toBe(401);
        const body = errorResponseSchema.parse(await resp.json());
        expect(body.error).toBeTruthy();
    });

    it("returns 401 when bearer token is invalid", async () => {
        const resp = await app.request(
            "/api/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer invalid_token",
                },
                body: JSON.stringify({
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                }),
            },
            BASE_ENV
        );
        expect(resp.status).toBe(401);
    });
});
