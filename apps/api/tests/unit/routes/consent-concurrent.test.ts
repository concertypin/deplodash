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

describe("Direct consent approvals", () => {
    beforeEach(() => {
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

    it("allows the same direct consent URL parameters to be approved repeatedly", async () => {
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/api/consent", consentRouter);
        const body = {
            repo: "testuser/repo",
            agent_id: "test-agent",
            scopes: "contents:read",
            repo_mode: "existing-only" as const,
        };

        const first = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            BASE_ENV
        );
        const second = await app.fetch(
            new Request("http://localhost/api/consent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            }),
            BASE_ENV
        );

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
    });
});
