import { it, expect, describe } from "vitest";
import { render } from "vitest-browser-svelte";
import Counter from "@/lib/Counter.svelte";

describe("Counter Component", () => {
    it("should render with default initial count", async () => {
        const screen = await render(Counter);
        expect(screen.getByText("Count is 0")).toBeVisible();
    });

    it("should render with custom initial count", async () => {
        const screen = await render(Counter, { initialCount: 5 });
        expect(screen.getByText("Count is 5")).toBeVisible();
    });

    it("should increment count", async () => {
        const screen = await render(Counter, { initialCount: 0 });
        const incBtn = screen.getByRole("button", { name: "Increment" });
        await incBtn.click();
        expect(screen.getByText("Count is 1")).toBeVisible();
    });

    it("should reset count", async () => {
        const screen = await render(Counter, { initialCount: 5 });
        const incBtn = screen.getByRole("button", { name: "Increment" });
        const resetBtn = screen.getByRole("button", { name: "Reset" });
        await incBtn.click();
        await resetBtn.click();
        expect(screen.getByText("Count is 5")).toBeVisible();
    });
});
