import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import ConsentPage from "@/lib/ConsentPage.svelte";

function mockFetchOnce(data: Record<string, unknown>, status = 200) {
    return Promise.resolve(
        new Response(JSON.stringify(data), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );
}

describe("ConsentPage — repo existence", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("shows three actions when repo does not exist", async () => {
        window.history.replaceState(
            null,
            "",
            "/auth/consent?repo=owner/missing-repo&scopes=contents:read" +
                "&agent_id=test-agent&repo_exists=false&repo_mode=create-if-missing"
        );

        const mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const urlStr =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.href;
            if (urlStr.includes("/api/user/me")) {
                return mockFetchOnce({ login: "testuser", avatarUrl: "" });
            }
            return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
        });

        const screen = await render(ConsentPage);

        await expect
            .element(screen.getByText("Authorization Required"))
            .toBeVisible();

        await expect
            .element(screen.getByText("Repository not found"))
            .toBeVisible();

        // Should show three action buttons for missing repo
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Allow without creating repository",
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Create private repo & allow",
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Cancel",
                })
            )
            .toBeVisible();
    });

    it("shows two actions when repo exists", async () => {
        window.history.replaceState(
            null,
            "",
            "/auth/consent?repo=owner/existing-repo&scopes=contents:read" +
                "&agent_id=test-agent&repo_exists=true"
        );

        const mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const urlStr =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.href;
            if (urlStr.includes("/api/user/me")) {
                return mockFetchOnce({
                    login: "testuser",
                    avatarUrl: "",
                });
            }
            return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
        });

        const screen = await render(ConsentPage);

        await expect
            .element(screen.getByText("Authorization Required"))
            .toBeVisible();

        // Should show Grant Access and Cancel
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Grant Access",
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Cancel",
                })
            )
            .toBeVisible();
    });
});
