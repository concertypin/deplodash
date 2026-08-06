import { describe, it, expect, vi, afterEach, assert } from "vitest";
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

function directConsentUrl(
    repo: string,
    agentId: string,
    scopes: string[],
    repoMode: string
) {
    const params = new URLSearchParams({
        repo,
        agent_id: agentId,
        scopes: scopes.join(","),
        repo_mode: repoMode,
    });
    return `/auth/consent?${params.toString()}`;
}

describe("ConsentPage — direct consent parameters", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders repository and create action from direct consent parameters", async () => {
        window.history.replaceState(
            null,
            "",
            directConsentUrl(
                "server-repo/example-repo",
                "agent-1",
                ["contents:read"],
                "create-if-missing"
            )
        );

        const mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.href;
            if (url === "/api/user/me") {
                return mockFetchOnce({ login: "testuser", avatarUrl: "" });
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        const screen = await render(ConsentPage);

        await expect
            .element(screen.getByText("Authorization Required"))
            .toBeVisible();
        await expect
            .element(screen.getByText("server-repo/example-repo"))
            .toBeVisible();
        await expect
            .element(
                screen.getByRole("button", {
                    name: "Create private repo & allow",
                })
            )
            .toBeVisible();
    });

    it("posts direct consent parameters for an existing repository", async () => {
        window.history.replaceState(
            null,
            "",
            directConsentUrl(
                "server-repo/other-repo",
                "agent-2",
                ["contents:read", "issues:read"],
                "existing-only"
            )
        );

        const mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
        mockFetch.mockImplementation((input: string | URL | Request) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : input.href;
            if (url === "/api/user/me") {
                return mockFetchOnce({ login: "testuser", avatarUrl: "" });
            }
            if (url === "/api/consent") {
                return mockFetchOnce({ error: "test" }, 400);
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        const screen = await render(ConsentPage);
        await expect
            .element(screen.getByText("Authorization Required"))
            .toBeVisible();
        await screen.getByRole("button", { name: "Grant Access" }).click();

        await vi.waitFor(() => {
            const consentCall = mockFetch.mock.calls.find(([input]) => {
                const url =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                return url.endsWith("/api/consent");
            });
            assert(consentCall);
            const init = consentCall[1];
            assert(typeof init?.body === "string");
            expect(JSON.parse(init.body)).toEqual({
                repo: "server-repo/other-repo",
                agent_id: "agent-2",
                repo_mode: "existing-only",
                scopes: "contents:read,issues:read",
            });
        });
    });
});
