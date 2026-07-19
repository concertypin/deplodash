import { describe, expect, it } from "vitest";
import { TEST_SECRET } from "@tests/helpers";
import { Hono, type MiddlewareHandler } from "hono";
import type { HonoEnv, SessionPayload } from "@/types";
import { sessionMiddleware } from "@/middleware";
import { getOrInitKey, encryptWith } from "@/crypto";
import { env } from "cloudflare:workers";
import { contains } from "@tests/helpers";

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
};

describe("Session-Based Authorization Boundaries", () => {
    it("authGuard renders login page when no token is available", async () => {
        const { authGuard } = await import("@/middleware");
        const app = new Hono<HonoEnv>()
            .use("*", (async (c, next) =>
                authGuard()(c, next)) satisfies MiddlewareHandler<HonoEnv>)
            .get("/protected", (c) => c.json({ secret: "data" }));

        const resp = await app.fetch(
            new Request("http://localhost/protected"),
            BASE_ENV
        );
        expect(resp.status).toBe(401);
        const body = await resp.json();
        expect(body).toEqual({ error: "Not authenticated" });
    });

    it("authGuard uses GITHUB_TOKEN as fallback (dev bypass)", async () => {
        const envWithToken: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_dev_bypass_token",
        };
        const { authGuard } = await import("@/middleware");
        const app = new Hono<HonoEnv>()
            .use("*", authGuard())
            .get("/protected", (c) => c.json({ status: "ok" }));

        const resp = await app.fetch(
            new Request("http://localhost/protected"),
            envWithToken
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    it("sessionMiddleware does not set gh_token with tampered cookie", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .get("/check", (c) => c.json({ hasToken: !!c.get("gh_token") }));

        const resp = await app.fetch(
            new Request("http://localhost/check", {
                headers: { Cookie: "session=tampered.invalid.value" },
            }),
            BASE_ENV
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "hasToken");
        expect(body?.hasToken).toBe(false);
    });

    it("sessionMiddleware does not set gh_token with expired session", async () => {
        const key = await getOrInitKey(TEST_SECRET);
        const past = Date.now() - 100_000;
        const expiredPayload: SessionPayload = {
            accessToken: "ghp_expired",
            refreshToken: "refresh_expired",
            accessExpiresAt: past,
            refreshExpiresAt: past,
        };
        const encrypted = await encryptWith(
            key,
            JSON.stringify(expiredPayload)
        );
        const cookie = `session=${encrypted}`;

        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .get("/check", (c) => c.json({ hasToken: !!c.get("gh_token") }));

        const resp = await app.fetch(
            new Request("http://localhost/check", {
                headers: { Cookie: cookie },
            }),
            BASE_ENV
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "hasToken");
        expect(body.hasToken).toBe(false);
    });
});
