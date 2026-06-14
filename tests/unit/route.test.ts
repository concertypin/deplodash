import { describe, expect, it, beforeEach } from "vitest";
import { router } from "@/route";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { resetKeyCache } from "@/crypto";
import { mockKVNamespace } from "../helpers";

// ─── Test helpers ────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-1234567890123456";
const MIN_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: mockKVNamespace(),
};

function createApp() {
    return new Hono<HonoEnv>().route("/", router);
}

beforeEach(() => {
    resetKeyCache();
});

// ─── Route tests ────────────────────────────────────────────────────────────

describe("route.ts - GET /auth/github", () => {
    const app = createApp();

    it("redirects to GitHub OAuth authorize URL", async () => {
        const resp = await app.request("/auth/github", {}, MIN_ENV);
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location") || "";
        expect(location).toContain("github.com/login/oauth/authorize");
        expect(location).toContain("client_id=test-client");
        expect(location).toContain("code_challenge");
        expect(location).toContain("code_challenge_method=S256");
        expect(location).toContain("scope=repo");
    });

    it("includes next parameter when provided", async () => {
        const resp = await app.request("/auth/github?next=/setup", {}, MIN_ENV);
        const location = resp.headers.get("Location") || "";
        // state contains encrypted JSON with {n:"/setup"}
        expect(resp.status).toBe(302);
        expect(location).toContain("state=");
    });
});

describe("route.ts - GET / (unauthenticated)", () => {
    const app = createApp();

    it("returns login page when no session cookie", async () => {
        const resp = await app.request("/", {}, MIN_ENV);
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Deploy Key Dashboard");
        expect(text).toContain("Login with GitHub");
    });
});

describe("route.ts - GET /callback", () => {
    const app = createApp();

    it("returns 400 when code and state are missing", async () => {
        const resp = await app.request("/callback", {}, MIN_ENV);
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Missing code or state");
    });

    it("returns 400 when state is missing", async () => {
        const resp = await app.request("/callback?code=testcode", {}, MIN_ENV);
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("Missing code or state");
    });
});

describe("route.ts - GET /logout", () => {
    const app = createApp();

    it("clears session cookie and redirects to /", async () => {
        const resp = await app.request("/logout", {}, MIN_ENV);
        expect(resp.status).toBe(302);
        const location = resp.headers.get("Location");
        expect(location).toBe("/");
        const setCookie = resp.headers.get("Set-Cookie") || "";
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("Max-Age=0");
    });
});
