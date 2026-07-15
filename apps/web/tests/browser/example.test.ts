import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import SnippetExample from "@/lib/SnippetExample.svelte";

describe("browser environment test", () => {
    it("should run in browser environment", () => {
        // Localstorage is only available in browser environment
        expect(localStorage).not.toBeNull();
    });

    it("should access window object in browser", () => {
        expect(window).toBeDefined();
        expect(document).toBeDefined();
    });

    it("should render SnippetExample component", async () => {
        const screen = await render(SnippetExample);
        expect(screen).toBeTruthy();
    });
});
