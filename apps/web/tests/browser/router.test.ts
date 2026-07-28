import { afterEach, describe, expect, it } from "vitest";
import { navigate, route } from "@/lib/router.svelte";

const originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

describe("History API router", () => {
    afterEach(() => {
        window.history.replaceState(null, "", originalUrl);
        route.current = window.location.pathname;
    });

    it("tracks the pathname when navigation includes query parameters", () => {
        navigate("/auth/consent?repo=org%2Frepo");

        expect(window.location.pathname).toBe("/auth/consent");
        expect(window.location.search).toBe("?repo=org%2Frepo");
        expect(route.current).toBe("/auth/consent");
    });
});
