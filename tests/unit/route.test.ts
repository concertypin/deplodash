import { describe, expect, it, beforeEach } from "vitest";
import { TEST_SECRET } from "../helpers";
import { testClient } from "hono/testing";
import { router } from "@/route";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { resetKeyCache } from "@/crypto";
import { env } from "cloudflare:workers";
import { z } from "zod";

const validatorErrorSchema = z.object({
    success: z.literal(false),
    error: z.array(
        z.object({
            code: z.string(),
            expected: z.string().optional(),
            path: z.array(z.string()),
            message: z.string(),
        })
    ),
    data: z.record(z.string(), z.unknown()),
});

// ─── Test helpers ────────────────────────────────────────────────────────────

const MIN_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
};

const app = new Hono<HonoEnv>().route("/", router);
const client = testClient(app, MIN_ENV);

beforeEach(() => {
    resetKeyCache();
});

// ─── Route tests ────────────────────────────────────────────────────────────

describe("route.ts - GET /auth/github", () => {
    it("redirects to GitHub OAuth authorize URL", async () => {
        const resp = await client.auth.github.$get({
            query: {},
        });
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location") || "";
        expect(location).toContain("github.com/login/oauth/authorize");
        expect(location).toContain("client_id=test-client");
        expect(location).toContain("code_challenge");
        expect(location).toContain("code_challenge_method=S256");
        expect(location).toContain("scope=repo");
    });

    it("includes next parameter when provided", async () => {
        const resp = await client.auth.github.$get({
            query: { next: "/setup" },
        });
        const location = resp.headers.get("Location") || "";
        // state contains encrypted JSON with {n:"/setup"}
        expect(resp.status).toBe(302);
        expect(location).toContain("state=");
    });
});

describe("route.ts - GET / (unauthenticated)", () => {
    it("returns login page when no session cookie", async () => {
        const resp = await client.index.$get();
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deplodash");
        expect(text).toContain("Login with GitHub");
    });
});

describe("route.ts - GET /callback", () => {
    it("returns 400 when code and state are missing", async () => {
        const resp = await client.callback.$get({
            query: { code: "", state: "" },
        });
        expect(resp.status).toBe(400);
        const body = validatorErrorSchema.parse(await resp.json());
        expect(body.success).toBe(false);
        expect(body.error.some((e) => e.path.includes("code"))).toBe(true);
        expect(body.error.some((e) => e.path.includes("state"))).toBe(true);
    });

    it("returns 400 when state is missing", async () => {
        const resp = await client.callback.$get({
            query: { code: "testcode", state: "" },
        });
        expect(resp.status).toBe(400);
        const body = validatorErrorSchema.parse(await resp.json());
        expect(body.success).toBe(false);
        expect(body.error.some((e) => e.path.includes("state"))).toBe(true);
    });
});

describe("route.ts - GET /logout", () => {
    it("clears session cookie and redirects to /", async () => {
        const resp = await client.logout.$get();
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toBe("/");
        const setCookie = resp.headers.get("Set-Cookie") || "";
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("Max-Age=0");
    });
});
