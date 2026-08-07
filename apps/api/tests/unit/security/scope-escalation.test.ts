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

describe("Direct consent scope validation", () => {
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

    async function postConsent(scopes: string): Promise<Response> {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        return app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo: "testuser/repo",
                    agent_id: "test-agent",
                    scopes,
                    repo_mode: "existing-only",
                }),
            }),
            BASE_ENV
        );
    }

    it("accepts the admin compound scope after expansion", async () => {
        const response = await postConsent("admin");
        expect(response.status).toBe(200);
    });

    it("rejects unsupported direct scopes", async () => {
        const response = await postConsent("repository:delete");
        expect(response.status).toBe(400);
    });

    it("allows a direct approval to be repeated without one-time state", async () => {
        const first = await postConsent("contents:read");
        const second = await postConsent("contents:read");
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
    });
});
