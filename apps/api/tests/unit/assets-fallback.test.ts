import { describe, expect, it, vi } from "vitest";
import app from "@/index";
import { makeBaseEnv } from "@tests/helpers";

describe("static asset fallback", () => {
    it("serves an unmatched SPA navigation through the assets binding", async () => {
        const fetchAsset = vi.fn<typeof fetch>(() =>
            Promise.resolve(new Response("SPA shell"))
        );
        const response = await app.fetch(
            new Request("https://deplodash.condev.workers.dev/auth/consent"),
            makeBaseEnv({ ASSETS: { fetch: fetchAsset } })
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("SPA shell");
        expect(fetchAsset).toHaveBeenCalledOnce();
        expect(fetchAsset).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "GET",
                url: "https://deplodash.condev.workers.dev/auth/consent",
            })
        );
    });

    it("returns 404 for an unmatched API request regardless of casing", async () => {
        const fetchAsset = vi.fn<typeof fetch>(() =>
            Promise.resolve(new Response("SPA shell"))
        );
        const response = await app.fetch(
            new Request("https://deplodash.condev.workers.dev/API/missing"),
            makeBaseEnv({ ASSETS: { fetch: fetchAsset } })
        );

        expect(response.status).toBe(404);
        expect(fetchAsset).not.toHaveBeenCalled();
    });

    it("does not serve assets for an unmatched non-GET request", async () => {
        const fetchAsset = vi.fn<typeof fetch>(() =>
            Promise.resolve(new Response("SPA shell"))
        );
        const response = await app.fetch(
            new Request("https://deplodash.condev.workers.dev/auth/consent", {
                method: "POST",
            }),
            makeBaseEnv({ ASSETS: { fetch: fetchAsset } })
        );

        expect(response.status).toBe(404);
        expect(fetchAsset).not.toHaveBeenCalled();
    });

    it("handles the OAuth start route before trying static assets", async () => {
        const fetchAsset = vi.fn<typeof fetch>(() =>
            Promise.resolve(new Response("SPA shell"))
        );
        const response = await app.fetch(
            new Request("https://deplodash.condev.workers.dev/auth/github"),
            makeBaseEnv({ ASSETS: { fetch: fetchAsset } })
        );

        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toContain(
            "github.com/login/oauth/authorize"
        );
        expect(fetchAsset).not.toHaveBeenCalled();
    });
});
