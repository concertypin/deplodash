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

    function mockDashboardFetch(
        consents: Array<Record<string, unknown>>,
        onRevoke?: (body: {
            repo: string;
            scopes: string;
            agent_id?: string;
        }) => Promise<Response>
    ) {
        const revokeCalls: Array<{
            repo: string;
            scopes: string;
            agent_id?: string;
        }> = [];
        mockFetch.mockImplementation(
            (input: string | URL | Request, init?: RequestInit) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.includes("/api/user/me")) {
                    return mockFetchOnce({
                        login: "testuser",
                        avatarUrl: "",
                        name: "Test User",
                    });
                }
                if (url.includes("/api/user/consents")) {
                    return mockFetchOnce({ consents });
                }
                if (url.includes("/api/user/agent/list")) {
                    return mockFetchOnce({ status: "ok", tokens: [] });
                }
                if (url.includes("/api/consent/revoke")) {
                    const bodyText =
                        typeof init?.body === "string"
                            ? init.body
                            : JSON.stringify(init?.body);
                    const parsed: unknown = JSON.parse(bodyText);
                    if (
                        typeof parsed !== "object" ||
                        parsed === null ||
                        !("repo" in parsed) ||
                        !("scopes" in parsed) ||
                        typeof parsed.repo !== "string" ||
                        typeof parsed.scopes !== "string"
                    ) {
                        throw new Error("invalid revoke payload");
                    }
                    const agentId =
                        "agent_id" in parsed &&
                        typeof parsed.agent_id === "string"
                            ? parsed.agent_id
                            : undefined;
                    const body = {
                        repo: parsed.repo,
                        scopes: parsed.scopes,
                        ...(agentId ? { agent_id: agentId } : {}),
                    } satisfies {
                        repo: string;
                        scopes: string;
                        agent_id?: string;
                    };
                    revokeCalls.push(body);
                    return onRevoke
                        ? onRevoke(body)
                        : mockFetchOnce({ status: "ok" });
                }
                return mockFetchOnce({});
            }
        );
        return revokeCalls;
    }

    it("renders the login page when API returns 401", async () => {
        // me endpoint returns 401
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
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
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
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
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
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
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
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

    it("opens the preauthorization modal for an existing agent token", async () => {
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
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
        await screen.getByRole("button", { name: "Pre-authorize" }).click();
        await expect
            .element(screen.getByPlaceholder("owner/repository"))
            .toBeVisible();
        await expect
            .element(
                screen.getByText("Approve an agent before it requests a token.")
            )
            .toBeVisible();
    });

    it("shows agent tokens in the list when present", async () => {
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
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

        await expect
            .element(screen.getByRole("cell", { name: "agent-alpha" }))
            .toBeVisible();
        await expect.element(screen.getByText("Agent Alpha")).toBeVisible();
    });
    it("groups duplicate consents into one row with deduped scopes and newest date", async () => {
        const consents = [
            {
                repo: "Owner/Repo",
                scopes: "contents:read",
                granted_at: "2026-07-25T00:00:00Z",
                agent_id: "agent-a",
            },
            {
                repo: "owner/repo",
                scopes: "contents:write, contents:read",
                granted_at: "2026-07-20T00:00:00Z",
                agent_id: "agent-a",
            },
        ];
        mockDashboardFetch(consents);

        const screen = await render(HomePage);

        // One row for the normalized repo/agent pair (newest record's casing)
        const rows = screen.getByRole("row");
        await expect.poll(() => rows.elements().length).toBe(2);
        // Union of both records' scopes, deduped, in first-seen order
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "contents:read, contents:write",
                    exact: true,
                })
            )
            .toBeVisible();
        // The newest grant date is shown, the older one is gone
        const newestDate = new Date(
            "2026-07-25T00:00:00Z"
        ).toLocaleDateString();
        const olderDate = new Date("2026-07-20T00:00:00Z").toLocaleDateString();
        await expect.element(screen.getByText(newestDate)).toBeVisible();
        await expect
            .element(screen.getByText(olderDate))
            .not.toBeInTheDocument();
        // Exactly one revoke control for the merged row
        const revokeControls = screen.getByRole("button", {
            name: "Revoke access to Owner/Repo",
        });
        await expect.poll(() => revokeControls.elements().length).toBe(1);
    });

    it("keeps consents for different agents in separate rows", async () => {
        const consents = [
            {
                repo: "Owner/Repo",
                scopes: "contents:write",
                granted_at: "2026-07-20T00:00:00Z",
                agent_id: "agent-a",
            },
            {
                repo: "Owner/Repo",
                scopes: "contents:read",
                granted_at: "2026-07-21T00:00:00Z",
                agent_id: "agent-b",
            },
        ];
        mockDashboardFetch(consents);

        const screen = await render(HomePage);

        // Two rows for the same repository under different agents
        const rows = screen.getByRole("row");
        await expect.poll(() => rows.elements().length).toBe(3);
        // Per-agent scopes stay separate, never unioned
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "contents:write",
                    exact: true,
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "contents:read",
                    exact: true,
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "contents:write, contents:read",
                    exact: true,
                })
            )
            .not.toBeInTheDocument();
        // One revoke control per row
        const revokeControls = screen.getByRole("button", {
            name: "Revoke access to Owner/Repo",
        });
        await expect.poll(() => revokeControls.elements().length).toBe(2);
    });

    it("revokes every original record with its exact payload and keeps only the failed member on partial failure", async () => {
        const consents = [
            {
                repo: "owner/repo",
                scopes: "contents:write, contents:read",
                granted_at: "2026-07-20T00:00:00Z",
                agent_id: "agent-a",
            },
            {
                repo: "OWNER/repo",
                scopes: "contents:read, contents:write",
                granted_at: "2026-07-19T00:00:00Z",
                agent_id: "agent-a",
            },
            {
                repo: "owner/repo",
                scopes: "workflows:write",
                granted_at: "2026-07-21T00:00:00Z",
                agent_id: "agent-a",
            },
        ];
        const revokeCalls = mockDashboardFetch(consents, (body) => {
            if (body.scopes === "workflows:write") {
                return mockFetchOnce(
                    { error: "Cannot revoke another user's consent" },
                    403
                );
            }
            return mockFetchOnce({ status: "ok" });
        });

        const screen = await render(HomePage);

        const revokeControl = screen.getByRole("button", {
            name: "Revoke access to owner/repo",
        });
        await expect.poll(() => revokeControl.elements().length).toBe(1);
        await revokeControl.click();

        // Every original member record is posted with its exact payload
        await expect.poll(() => revokeCalls.length).toBe(2);
        expect(revokeCalls).toEqual(
            expect.arrayContaining([
                {
                    repo: "owner/repo",
                    scopes: "contents:write, contents:read",
                    agent_id: "agent-a",
                },
                {
                    repo: "owner/repo",
                    scopes: "workflows:write",
                    agent_id: "agent-a",
                },
            ])
        );

        // Ownership error takes precedence over the successful request
        await expect
            .element(screen.getByText("You cannot revoke this consent"))
            .toBeVisible();

        // Only the failed member's scopes remain rendered
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "workflows:write",
                    exact: true,
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "contents:write, contents:read, workflows:write",
                    exact: true,
                })
            )
            .not.toBeInTheDocument();
    });

    it("shows a generic error and accurate remaining scopes when a revoke request rejects", async () => {
        const consents = [
            {
                repo: "owner/repo",
                scopes: "contents:write, contents:read",
                granted_at: "2026-07-20T00:00:00Z",
                agent_id: "agent-a",
            },
            {
                repo: "owner/repo",
                scopes: "workflows:write",
                granted_at: "2026-07-21T00:00:00Z",
                agent_id: "agent-a",
            },
        ];
        const revokeCalls = mockDashboardFetch(consents, (body) => {
            if (body.scopes === "contents:write, contents:read") {
                return Promise.reject(new Error("network down"));
            }
            return mockFetchOnce({ status: "ok" });
        });

        const screen = await render(HomePage);

        const revokeControl = screen.getByRole("button", {
            name: "Revoke access to owner/repo",
        });
        await revokeControl.click();

        // The rejected member still sent its exact payload
        await expect.poll(() => revokeCalls.length).toBe(2);
        expect(revokeCalls).toEqual(
            expect.arrayContaining([
                {
                    repo: "owner/repo",
                    scopes: "contents:write, contents:read",
                    agent_id: "agent-a",
                },
                {
                    repo: "owner/repo",
                    scopes: "workflows:write",
                    agent_id: "agent-a",
                },
            ])
        );

        // Rejected requests surface the generic error, not the ownership error
        await expect
            .element(screen.getByText("Failed to revoke consent"))
            .toBeVisible();
        await expect
            .element(screen.getByText("You cannot revoke this consent"))
            .not.toBeInTheDocument();

        // Only the rejected member's scopes remain rendered
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "contents:write, contents:read",
                    exact: true,
                })
            )
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("cell", {
                    name: "workflows:write",
                    exact: true,
                })
            )
            .not.toBeInTheDocument();
    });

    it("disables the group revoke control while the paced batch is pending", async () => {
        const consents = [
            {
                repo: "owner/repo",
                scopes: "contents:write, contents:read",
                granted_at: "2026-07-20T00:00:00Z",
                agent_id: "agent-a",
            },
            {
                repo: "owner/repo",
                scopes: "workflows:write",
                granted_at: "2026-07-21T00:00:00Z",
                agent_id: "agent-a",
            },
        ];
        // One member fails so the handler settles without reloading.
        const revokeCalls = mockDashboardFetch(consents, (body) => {
            if (body.scopes === "workflows:write") {
                return mockFetchOnce(
                    { error: "Cannot revoke another user's consent" },
                    403
                );
            }
            return mockFetchOnce({ status: "ok" });
        });

        const screen = await render(HomePage);

        const revokeControl = screen.getByRole("button", {
            name: "Revoke access to owner/repo",
        });
        await expect.poll(() => revokeControl.elements().length).toBe(1);
        await revokeControl.click();

        // While the paced batch is pending, the control is disabled so a
        // second click cannot schedule another batch against the rate limit.
        await expect.element(revokeControl).toBeDisabled();
        await expect.poll(() => revokeCalls.length).toBe(2);
        await expect.element(revokeControl).toBeEnabled();
    });
});
