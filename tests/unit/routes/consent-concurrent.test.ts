import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { THROWING_KV } from "../../helpers";

const CONCURRENT_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: THROWING_KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    GITHUB_TOKEN: "ghp_concurrent_test",
};

describe("Consent scope validation (concurrent-safe)", () => {
    it.concurrent("rejects encrypted scope replayed to a different repo", async () => {
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const getResp = await app.fetch(
            new Request("http://localhost/auth/consent?repo=victim%2Frepo&scopes=contents:read&agent_id=agent-A"),
            CONCURRENT_ENV
        );
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();
        const encMatch = getText.match(/name="requested_scopes_enc" value="([^"]+)"/);
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "attacker/repo", scopes: "contents:read", agent_id: "agent-A", requested_scopes_enc: encryptedValue }),
            }), CONCURRENT_ENV
        );
        expect(postResp.status).toBe(400);
        expect(await postResp.text()).toContain("Invalid consent request");
    });

    it.concurrent("rejects encrypted scope replayed to a different agent", async () => {
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const getResp = await app.fetch(
            new Request("http://localhost/auth/consent?repo=owner%2Frepo&scopes=contents:read&agent_id=agent-A"),
            CONCURRENT_ENV
        );
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();
        const encMatch = getText.match(/name="requested_scopes_enc" value="([^"]+)"/);
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", scopes: "contents:read", agent_id: "agent-B", requested_scopes_enc: encryptedValue }),
            }), CONCURRENT_ENV
        );
        expect(postResp.status).toBe(400);
        expect(await postResp.text()).toContain("Invalid consent request");
    });

    it.concurrent("rejects empty scopes (no checkbox checked)", async () => {
        const app = new Hono<HonoEnv>().use("*", sessionMiddleware()).route("/auth", consentRouter);
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ repo: "owner/repo", requested_scopes: "contents:read", agent_id: "test-agent" }),
            }), CONCURRENT_ENV
        );
        expect(resp.status).toBe(400);
        expect(await resp.text()).toContain("You must select at least one permission");
    });
});
