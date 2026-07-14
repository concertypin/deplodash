import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { encryptWith, getOrInitKey } from "@/crypto";
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
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    GITHUB_TOKEN: "ghp_concurrent_test",
};

describe("Consent scope validation (concurrent-safe)", () => {
    it.concurrent(
        "rejects encrypted scope replayed to a different repo",
        async () => {
            const app = new Hono<HonoEnv>()
                .use("*", sessionMiddleware())
                .route("/api/consent", consentRouter);

            const key = await getOrInitKey(CONCURRENT_ENV.ENCRYPTION_SECRET);
            const encrypted = await encryptWith(
                key,
                JSON.stringify({
                    scopes: "contents:read",
                    repo: "victim/repo",
                    agent_id: "agent-A",
                })
            );

            const postResp = await app.fetch(
                new Request("http://localhost/api/consent", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        repo: "different/repo",
                        scopes: "contents:read",
                        requested_scopes_enc: encrypted,
                        agent_id: "agent-A",
                    }),
                }),
                CONCURRENT_ENV
            );
            expect(postResp.status).toBe(400);
            expect(await postResp.json()).toEqual({
                error: "Invalid consent request. Please try again from the agent's link.",
            });
        }
    );

    it.concurrent(
        "rejects encrypted scope replayed to a different agent",
        async () => {
            const app = new Hono<HonoEnv>()
                .use("*", sessionMiddleware())
                .route("/api/consent", consentRouter);

            const key = await getOrInitKey(CONCURRENT_ENV.ENCRYPTION_SECRET);
            const encrypted = await encryptWith(
                key,
                JSON.stringify({
                    scopes: "contents:read",
                    repo: "owner/repo",
                    agent_id: "agent-A",
                })
            );

            const postResp = await app.fetch(
                new Request("http://localhost/api/consent", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        repo: "owner/repo",
                        scopes: "contents:read",
                        agent_id: "agent-B",
                        requested_scopes_enc: encrypted,
                    }),
                }),
                CONCURRENT_ENV
            );
            expect(postResp.status).toBe(400);
            expect(await postResp.json()).toEqual({
                error: "Invalid consent request. Please try again from the agent's link.",
            });
        }
    );

    it.concurrent("rejects empty scopes (no checkbox checked)", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);

        const key = await getOrInitKey(CONCURRENT_ENV.ENCRYPTION_SECRET);
        const encrypted = await encryptWith(
            key,
            JSON.stringify({
                scopes: "contents:read",
                repo: "owner/repo",
                agent_id: "test-agent",
            })
        );

        // POST with a valid encrypted payload but no scopes selected (no scopes field)
        const resp = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "owner/repo",
                    requested_scopes_enc: encrypted,
                    agent_id: "test-agent",
                    // no scopes field
                }),
            }),
            CONCURRENT_ENV
        );
        expect(resp.status).toBe(400);
        expect(await resp.json()).toEqual({
            error: "You must select at least one permission to proceed.",
        });
    });
});
