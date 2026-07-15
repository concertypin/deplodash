import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import HomePage from "@/lib/HomePage.svelte";

function mockFetchOnce(data: Record<string, unknown>, status = 200) {
    return Promise.resolve(
        new Response(JSON.stringify(data), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );
}

describe("HomePage", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(() => {
        mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders the login page when API returns 401", async () => {
        // me endpoint returns 401
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/api/user/me")) {
                return mockFetchOnce({}, 401);
            }
            return mockFetchOnce({});
        });

        const screen = await render(HomePage);
        // Wait for the loading to finish
        const loginBtn = screen.getByText("Login with GitHub");
        await expect.element(loginBtn).toBeVisible();
        await expect.element(screen.getByText("Deplodash")).toBeVisible();
    });

    it("renders the dashboard with agent tokens section", async () => {
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/api/user/me")) {
                return mockFetchOnce({
                    login: "testuser",
                    avatarUrl: "",
                    name: "Test User",
                });
            }
            if (url.includes("/api/user/consents")) {
                return mockFetchOnce({ consents: [] });
            }
            if (url.includes("/api/user/agent/list")) {
                return mockFetchOnce({
                    status: "ok",
                    tokens: [],
                });
            }
            return mockFetchOnce({});
        });

        const screen = await render(HomePage);

        await expect.element(screen.getByText("Welcome,")).toBeVisible();
        await expect
            .element(
                screen.getByRole("heading", {
                    name: "Agent Tokens",
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Issue Agent Token",
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("heading", {
                    name: "Authorized Repositories",
                })
            )
            .toBeVisible();
    });

    it("shows empty state when no agent tokens exist", async () => {
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/api/user/me")) {
                return mockFetchOnce({
                    login: "testuser",
                    avatarUrl: "",
                    name: "Test User",
                });
            }
            if (url.includes("/api/user/consents")) {
                return mockFetchOnce({ consents: [] });
            }
            if (url.includes("/api/user/agent/list")) {
                return mockFetchOnce({
                    status: "ok",
                    tokens: [],
                });
            }
            return mockFetchOnce({});
        });

        const screen = await render(HomePage);

        await expect
            .element(screen.getByText("No agent tokens created yet"))
            .toBeVisible();
        await expect
            .element(
                screen.getByText(
                    "Create a token to authenticate your AI agents."
                )
            )
            .toBeVisible();
    });

    it("opens the issue token modal when clicking the button", async () => {
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/api/user/me")) {
                return mockFetchOnce({
                    login: "testuser",
                    avatarUrl: "",
                    name: "Test User",
                });
            }
            if (url.includes("/api/user/consents")) {
                return mockFetchOnce({ consents: [] });
            }
            if (url.includes("/api/user/agent/list")) {
                return mockFetchOnce({
                    status: "ok",
                    tokens: [],
                });
            }
            return mockFetchOnce({});
        });

        const screen = await render(HomePage);

        // Open the modal
        const issueBtn = screen.getByRole("button", {
            name: "Issue Agent Token",
        });
        await expect.element(issueBtn).toBeVisible();
        await issueBtn.click();

        // Modal should show the form
        await expect
            .element(screen.getByPlaceholder("my-ai-agent"))
            .toBeVisible();
        await expect
            .element(screen.getByPlaceholder("My AI Agent"))
            .toBeVisible();
    });

    it("shows agent tokens in the list when present", async () => {
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/api/user/me")) {
                return mockFetchOnce({
                    login: "testuser",
                    avatarUrl: "",
                    name: "Test User",
                });
            }
            if (url.includes("/api/user/consents")) {
                return mockFetchOnce({ consents: [] });
            }
            if (url.includes("/api/user/agent/list")) {
                return mockFetchOnce({
                    status: "ok",
                    tokens: [
                        {
                            token: "abc123def456token",
                            agent_id: "agent-alpha",
                            label: "Agent Alpha",
                            created_at: "2026-07-15T12:00:00Z",
                        },
                    ],
                });
            }
            return mockFetchOnce({});
        });

        const screen = await render(HomePage);

        await expect.element(screen.getByText("agent-alpha")).toBeVisible();
        await expect.element(screen.getByText("Agent Alpha")).toBeVisible();
    });
});
