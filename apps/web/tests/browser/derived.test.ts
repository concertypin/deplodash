import { it, expect, describe } from "vitest";
import { render } from "vitest-browser-svelte";
import DerivedLabel from "@/lib/DerivedLabel.svelte";

describe("DerivedLabel Component", () => {
    it("should render initial values", async () => {
        const screen = await render(DerivedLabel);
        expect(screen.getByText(/Count: 0/)).toBeVisible();
        expect(screen.getByText(/Double: 0/)).toBeVisible();
    });

    it("should update double value when count changes", async () => {
        const screen = await render(DerivedLabel);
        const incBtn = screen.getByRole("button", { name: "+1" });

        await incBtn.click();
        expect(screen.getByText(/Count: 1/)).toBeVisible();
        expect(screen.getByText(/Double: 2/)).toBeVisible();
    });
});
