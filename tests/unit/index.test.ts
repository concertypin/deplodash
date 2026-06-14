import { describe, expect, it } from "vitest";
import app from "@/index";
import type { HonoEnv } from "@/types";

const MIN_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: "test-secret-1234567890123456",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
};

describe("index.ts - app configuration", () => {
    it("responds on root route", async () => {
        const resp = await app.request("/", {}, MIN_ENV);
        expect(resp.status).toBe(200);
    });

    it("includes CORS headers in response", async () => {
        const resp = await app.request(
            "/",
            {
                headers: { Origin: "http://example.com" },
            },
            MIN_ENV
        );
        const vary = resp.headers.get("Vary");
        expect(vary).toBeTruthy();
        const acao = resp.headers.get("Access-Control-Allow-Origin");
        expect(acao).toBe("http://example.com");
    });

    it("serves OpenAPI spec at /openapi.json", async () => {
        const resp = await app.request("/openapi.json", {}, MIN_ENV);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            info: { title: string; version: string };
            paths: unknown;
        };
        expect(body.info.title).toBe("Deplodash API");
        expect(body.info.version).toBe("1.0.0");
        expect(body.paths).toBeDefined();
    });

    it("serves Scalar docs at /docs", async () => {
        const resp = await app.request("/docs", {}, MIN_ENV);
        expect(resp.status).toBe(200);
        const text = await resp.text();
        expect(text).toContain("Scalar");
    });
});
