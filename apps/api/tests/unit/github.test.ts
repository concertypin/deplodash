import { describe, expect, it, vi, beforeEach } from "vitest";
import { jsonResponse } from "../helpers";
import { GitHubClient } from "@/github";

describe("GitHubClient", () => {
    let client: GitHubClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn<() => Promise<Response>>();
        vi.stubGlobal("fetch", mockFetch);
        client = new GitHubClient("ghp_test_token");
    });

    describe("exchangeCode", () => {
        it("exchanges a code for an access token", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    access_token: "gho_new_token",
                    token_type: "bearer",
                    scope: "repo,user",
                    expires_in: 28800,
                    refresh_token: "ghr_test_refresh",
                    refresh_token_expires_in: 15811200,
                })
            );

            const token = await client.exchangeCode(
                "test-code",
                "test-verifier",
                "client-id",
                "client-secret",
                "http://localhost/callback"
            );

            expect(token.accessToken).toBe("gho_new_token");
            expect(token.refreshToken).toBe("ghr_test_refresh");
            expect(token.expiresIn).toBe(28800);
            expect(mockFetch).toHaveBeenCalledWith(
                "https://github.com/login/oauth/access_token",
                expect.objectContaining({
                    method: "POST",
                    body: expect.stringContaining(
                        "test-code"
                    ) as unknown as string,
                })
            );
        });

        it("throws when access_token is empty string", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    access_token: "",
                    token_type: "bearer",
                    scope: "",
                    expires_in: 28800,
                    refresh_token: "ghr_abc",
                    refresh_token_expires_in: 15811200,
                })
            );

            await expect(
                client.exchangeCode(
                    "code",
                    "verifier",
                    "id",
                    "secret",
                    "http://localhost/callback"
                )
            ).rejects.toThrow("No access_token in OAuth response");
        });
    });

    describe("getUser", () => {
        it("returns user info", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    id: 1,
                    login: "testuser",
                    avatar_url: "https://example.com/avatar.png",
                    name: "Test User",
                })
            );

            const user = await client.getUser();
            expect(user.login).toBe("testuser");
            expect(user.id).toBe(1);
            expect(user.avatar_url).toBe("https://example.com/avatar.png");
            expect(mockFetch).toHaveBeenCalledWith(
                "https://api.github.com/user",
                expect.any(Object)
            );
        });
    });

    describe("listAllRepos", () => {
        it("returns all repos from a single page", async () => {
            const repos = [
                {
                    full_name: "owner/repo1",
                    name: "repo1",
                    owner: { login: "owner" },
                    private: false,
                    html_url: "",
                    description: null,
                },
                {
                    full_name: "owner/repo2",
                    name: "repo2",
                    owner: { login: "owner" },
                    private: true,
                    html_url: "",
                    description: null,
                },
            ];
            mockFetch.mockResolvedValue(jsonResponse(repos));

            const result = await client.listAllRepos();
            expect(result).toHaveLength(2);
            expect(result[0]!.full_name).toBe("owner/repo1");
        });

        it("handles pagination across multiple pages", async () => {
            const page1 = Array.from({ length: 100 }, (_, i) => ({
                full_name: `owner/repo${i}`,
                name: `repo${i}`,
                owner: { login: "owner" },
                private: false,
                html_url: "",
                description: null,
            }));
            const page2 = [
                {
                    full_name: "owner/repo100",
                    name: "repo100",
                    owner: { login: "owner" },
                    private: false,
                    html_url: "",
                    description: null,
                },
            ];

            mockFetch
                .mockResolvedValueOnce(jsonResponse(page1))
                .mockResolvedValueOnce(jsonResponse(page2));

            const result = await client.listAllRepos();
            expect(result).toHaveLength(101);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe("createRepo", () => {
        it("creates a private repository", async () => {
            const created = {
                full_name: "owner/new-repo",
                name: "new-repo",
                owner: { login: "owner" },
                private: true,
                html_url: "",
                description: null,
            };
            mockFetch.mockResolvedValue(jsonResponse(created, 201));

            const result = await client.createRepo("new-repo", true);
            expect(result.full_name).toBe("owner/new-repo");
            expect(mockFetch).toHaveBeenCalledWith(
                "https://api.github.com/user/repos",
                expect.objectContaining({
                    method: "POST",
                    body: expect.stringContaining(
                        '"private":true'
                    ) as unknown as string,
                })
            );
        });

        it("creates a public repository", async () => {
            const created = {
                full_name: "owner/public-repo",
                name: "public-repo",
                owner: { login: "owner" },
                private: false,
                html_url: "",
                description: null,
            };
            mockFetch.mockResolvedValue(jsonResponse(created, 201));

            const result = await client.createRepo("public-repo", false);
            expect(result.private).toBe(false);
            expect(mockFetch).toHaveBeenCalledWith(
                "https://api.github.com/user/repos",
                expect.objectContaining({
                    body: expect.stringContaining(
                        '"private":false'
                    ) as unknown as string,
                })
            );
        });
    });

    describe("rateLimit", () => {
        it("returns rate limit info", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    rate: { remaining: 42, limit: 5000, reset: 1234567890 },
                })
            );

            const result = await client.rateLimit();
            expect(result.remaining).toBe(42);
            expect(result.limit).toBe(5000);
            expect(result.reset).toBe(1234567890);
        });
    });

    describe("error handling", () => {
        it("throws TokenExpiredError on 401 response", async () => {
            const { TokenExpiredError } = await import("@/errors");
            mockFetch.mockResolvedValue(
                new Response("Unauthorized", { status: 401 })
            );

            await expect(client.getUser()).rejects.toThrow(TokenExpiredError);
        });

        it("throws detailed error with rate limit info on non-ok status", async () => {
            mockFetch.mockResolvedValue(
                new Response("Not Found", {
                    status: 404,
                    headers: {
                        "X-RateLimit-Remaining": "4999",
                        "X-RateLimit-Reset": "2000000000",
                    },
                })
            );

            await expect(client.getUser()).rejects.toThrow(/GitHub 404/);
            await expect(client.getUser()).rejects.toThrow(/Remaining: 4999/);
        });

        it("throws on 204 no content from repos endpoint (invalid response)", async () => {
            mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

            await expect(client.listAllRepos()).rejects.toThrow("not iterable");
        });

        it("includes error body in exception message", async () => {
            mockFetch.mockResolvedValue(
                new Response('{"message":"Repository not found"}', {
                    status: 403,
                    headers: { "Content-Type": "application/json" },
                })
            );

            await expect(client.getUser()).rejects.toThrow(
                /Repository not found/
            );
        });

        it("includes rate limit reset time in error message", async () => {
            const resetTime = Math.floor(Date.now() / 1000) + 3600;
            mockFetch.mockResolvedValue(
                new Response("Rate limited", {
                    status: 403,
                    headers: {
                        "X-RateLimit-Remaining": "0",
                        "X-RateLimit-Reset": String(resetTime),
                    },
                })
            );

            await expect(client.getUser()).rejects.toThrow(/Remaining: 0/);
            await expect(client.getUser()).rejects.toThrow(/Resets:/);
        });
    });

    describe("custom headers merging", () => {
        it("merges plain object headers via req method", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    login: "testuser",
                    id: 1,
                    avatar_url: "",
                    name: null,
                })
            );

            // Access the private `req` method via runtime reflection
            // TypeScript's `private` is a compile-time-only check
            const reqMethod = Reflect.get(client, "req") as (
                path: string,
                init?: RequestInit
            ) => Promise<unknown>;
            await reqMethod.call(client, "/user", {
                headers: { "X-Custom": "custom-value" },
            });

            const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
            const headers = callInit.headers as Record<string, string>;
            expect(headers.Authorization).toContain("ghp_test_token");
            expect(headers["X-Custom"]).toBe("custom-value");
        });

        it("merges Headers instance headers via req method", async () => {
            mockFetch.mockResolvedValue(jsonResponse([]));

            const reqMethod = Reflect.get(client, "req") as (
                path: string,
                init?: RequestInit
            ) => Promise<unknown>;
            const customHeaders = new Headers({
                "If-None-Match": 'W/"abc123"',
            });
            await reqMethod.call(client, "/user/repos", {
                headers: customHeaders,
            });

            const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
            const headers = callInit.headers as Record<string, string>;
            // Headers.forEach lowercases keys
            expect(headers["if-none-match"]).toBe('W/"abc123"');
        });

        it("merges array-of-tuples headers via req method", async () => {
            mockFetch.mockResolvedValue(jsonResponse([]));

            const reqMethod = Reflect.get(client, "req") as (
                path: string,
                init?: RequestInit
            ) => Promise<unknown>;
            await reqMethod.call(client, "/user/repos", {
                headers: [
                    ["X-Array", "value1"],
                    ["X-Array-2", "value2"],
                ],
            });

            const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
            const headers = callInit.headers as Record<string, string>;
            expect(headers["X-Array"]).toBe("value1");
            expect(headers["X-Array-2"]).toBe("value2");
        });

        it("exchangeCode sends correct auth headers", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    access_token: "gho_token",
                    token_type: "bearer",
                    scope: "repo",
                    expires_in: 28800,
                    refresh_token: "ghr_abc",
                    refresh_token_expires_in: 15811200,
                })
            );

            await client.exchangeCode(
                "code",
                "verifier",
                "client-id",
                "client-secret",
                "http://localhost/callback"
            );

            const callInit = mockFetch.mock.calls[0]?.[1] as
                | RequestInit
                | undefined;
            expect(callInit?.headers).toBeDefined();
            const headers = callInit?.headers as Record<string, string>;
            expect(headers["Content-Type"]).toBe("application/json");
            expect(callInit?.body).toContain("client-id");
        });

        it("exchangeCode throws when response has wrong token_type", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    access_token: "gho_token",
                    token_type: "invalid_type",
                    scope: "repo",
                    expires_in: 28800,
                    refresh_token: "ghr_abc",
                    refresh_token_expires_in: 15811200,
                })
            );

            await expect(
                client.exchangeCode(
                    "code",
                    "verifier",
                    "id",
                    "secret",
                    "http://localhost/callback"
                )
            ).rejects.toThrow(Error);
        });
    });
});
