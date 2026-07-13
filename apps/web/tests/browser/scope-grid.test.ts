import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import ScopeGrid from "@/lib/ScopeGrid.svelte";

describe("ScopeGrid component", () => {
    it("should render all 9 scope category labels", async () => {
        const screen = await render(ScopeGrid);
        await expect
            .element(
                screen.getByRole("heading", { name: "Repository Contents" })
            )
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Issues" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Pull Requests" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Actions & CI" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Metadata" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Administration" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Security & Access" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Pages & Webhooks" }))
            .toBeVisible();
        await expect
            .element(screen.getByRole("heading", { name: "Environments" }))
            .toBeVisible();
    });

    it("should render all scope ids", async () => {
        const screen = await render(ScopeGrid);

        const knownScopes = [
            "contents:read",
            "issues:write",
            "actions:read",
            "secrets:write",
            "environments:read",
        ];
        for (const scope of knownScopes) {
            await expect.element(screen.getByText(scope)).toBeVisible();
        }
    });

    it("should render scope descriptions", async () => {
        const screen = await render(ScopeGrid);

        await expect
            .element(screen.getByText("Read repository contents"))
            .toBeVisible();
        await expect
            .element(screen.getByText("Manage deployments"))
            .toBeVisible();
        await expect
            .element(screen.getByText("Read & write issues"))
            .toBeVisible();
    });
});
