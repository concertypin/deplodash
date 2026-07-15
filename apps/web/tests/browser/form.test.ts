import { it, expect, describe } from "vitest";
import { render } from "vitest-browser-svelte";
import Form from "@/lib/Form.svelte";

describe("Form Component", () => {
    it("should render form with input fields", async () => {
        const screen = await render(Form);

        expect(screen.getByLabelText("Name")).toBeVisible();
        expect(screen.getByLabelText("Email")).toBeVisible();
    });

    it("should have submit button", async () => {
        const screen = await render(Form);

        const submitBtn = screen.getByRole("button", { name: "Submit" });
        expect(submitBtn).toBeVisible();
    });
});
