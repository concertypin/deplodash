import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import type { HonoEnv } from "@/types";
import { makeBaseEnv } from "@tests/helpers";

const BASE_ENV: HonoEnv["Bindings"] = {
    ...makeBaseEnv(),
    KV: env.KV,
    GITHUB_TOKEN: "ghp_test_user_token",
};

describe("Direct consent request validation", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((key) => env.KV.delete(key.name)));
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(() =>
                Promise.resolve(
                    Response.json({
                        login: "testuser",
                        id: 1,
                        avatar_url: "",
                        name: "Test User",
                    })
                )
            )
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("rejects a direct request without a repository", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        const response = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agent_id: "test-agent",
                    scopes: "contents:read",
                }),
            }),
            BASE_ENV
        );

        expect(response.status).toBe(400);
    });

    it("rejects direct consent with no usable scopes", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        const response = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    agent_id: "test-agent",
                    scopes: ",",
                }),
            }),
            BASE_ENV
        );

        expect(response.status).toBe(400);
    });

    it("rejects malformed repository identifiers", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        const response = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo/extra",
                    agent_id: "test-agent",
                    scopes: "contents:read",
                }),
            }),
            BASE_ENV
        );

        expect(response.status).toBe(400);
    });

    it("accepts direct consent parameters from a proactive approval", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        const response = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    agent_id: "test-agent",
                    scopes: "contents:read",
                    repo_mode: "existing-only",
                }),
            }),
            BASE_ENV
        );

        expect(response.status).toBe(200);
    });
});
