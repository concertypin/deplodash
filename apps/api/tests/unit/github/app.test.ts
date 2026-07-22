import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { jsonResponse } from "@tests/helpers";
import { GitHubApp } from "@/github/app";

// ─── RSA Key Setup ───────────────────────────────────────────────────────────

let pkcs8Pem: string;

beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const pkcs8Bytes = new Uint8Array(pkcs8);
    const b64 = btoa(String.fromCharCode(...pkcs8Bytes));
    const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
    pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
});

describe("GitHubApp", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(() => {
        mockFetch = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", mockFetch);
    });

    it("constructs a new instance", () => {
        const app = new GitHubApp("123456", pkcs8Pem);
        expect(app).toBeInstanceOf(GitHubApp);
    });

    describe("resolveInstallationId", () => {
        it("resolves org installation", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({ id: 42, account: { login: "myorg" } })
            );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.resolveInstallationId("myorg");
            expect(result).toBe("42");
            const fetchUrl = mockFetch.mock.calls[0]![0] as string;
            expect(fetchUrl).toContain("/orgs/myorg/installation");
        });

        it("falls back from org 404 to user installation", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({ id: 99, account: { login: "myuser" } })
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.resolveInstallationId("myuser");
            expect(result).toBe("99");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("uses in-memory cache for repeated calls to the same owner", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({ id: 7, account: { login: "cached-org" } })
            );
            const app = new GitHubApp("123456", pkcs8Pem);
            const first = await app.resolveInstallationId("cached-org");
            const second = await app.resolveInstallationId("cached-org");
            expect(first).toBe("7");
            expect(second).toBe("7");
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it("throws on unexpected org endpoint status (non-404) without leaking body", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({ message: "Server error" }, 500)
            );
            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.resolveInstallationId("err-org");
            } catch (e) {
                thrown = e as Error;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toMatch(
                /failed to check org installation/i
            );
            expect(thrown!.message).not.toContain("Server error");
        });

        it("throws on unexpected user endpoint status after org 404 without leaking body", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Server error" }, 500)
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.resolveInstallationId("err-user");
            } catch (e) {
                thrown = e as Error;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toMatch(
                /failed to check user installation/i
            );
            expect(thrown!.message).not.toContain("Server error");
        });

        it("throws when both org and user return 404 (not installed)", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            await expect(
                app.resolveInstallationId("uninstalled-org")
            ).rejects.toThrow(/not installed/i);
        });

        it("caches per-owner independently", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "org-a" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ id: 20, account: { login: "org-b" } })
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            const a = await app.resolveInstallationId("org-a");
            const b = await app.resolveInstallationId("org-b");
            expect(a).toBe("10");
            expect(b).toBe("20");
            expect(mockFetch).toHaveBeenCalledTimes(2);
            const a2 = await app.resolveInstallationId("org-a");
            expect(a2).toBe("10");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe("getInstallationToken", () => {
        it("returns a token for a valid installation", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    token: "ghs_token123",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { contents: "read" },
                    repository_selection: "selected",
                })
            );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.getInstallationToken(
                { contents: "read" },
                "42"
            );
            expect(result.token).toBe("ghs_token123");
            expect(result.expires_at).toBe("2026-12-31T23:59:59Z");
            expect(result.permissions).toEqual({ contents: "read" });
            expect(result.repositorySelection).toBe("selected");
            expect(mockFetch.mock.calls[0]![0] as string).toContain(
                "/app/installations/42/access_tokens"
            );
        });

        it("throws when no installationId is provided", async () => {
            const app = new GitHubApp("123456", pkcs8Pem);
            await expect(
                app.getInstallationToken({ contents: "read" }, undefined)
            ).rejects.toThrow(/no installation id/i);
        });

        it("throws on GitHub API error response without leaking body", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({ message: "Bad credentials" }, 401)
            );
            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.getInstallationToken({ contents: "read" }, "42");
            } catch (e) {
                thrown = e as Error;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toMatch(/token request failed/i);
            expect(thrown!.message).not.toContain("Bad credentials");
        });

        it("includes repositories in the POST body when provided", async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({
                    token: "ghs_token_repo_scoped",
                    expires_at: "2026-12-31T23:59:59Z",
                    permissions: { contents: "read" },
                    repository_selection: "selected",
                })
            );
            const app = new GitHubApp("123456", pkcs8Pem);
            await app.getInstallationToken({ contents: "read" }, "42", [
                "my-repo",
            ]);

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [callUrl, callInit] = mockFetch.mock.calls[0] ?? [];
            expect(callUrl).toBeDefined();
            expect(callInit).toBeDefined();

            // Check URL — extract string representation safely
            const urlStr =
                typeof callUrl === "string"
                    ? callUrl
                    : callUrl instanceof URL
                      ? callUrl.toString()
                      : "";
            expect(urlStr).toContain("/app/installations/42/access_tokens");

            // Check body contains repositories field
            const bodyText =
                callInit && typeof callInit.body === "string"
                    ? callInit.body
                    : null;
            expect(bodyText).not.toBeNull();
            expect(bodyText).toContain('"repositories"');
            expect(bodyText).toContain('"my-repo"');
            expect(bodyText).toContain('"permissions"');
        });
    });

    describe("requestToken", () => {
        it("resolves installation and returns a token", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 55, account: { login: "test-owner" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "ghs_final_token",
                        expires_at: "2027-06-01T00:00:00Z",
                        permissions: { contents: "read" },
                        repository_selection: "all",
                    })
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.requestToken(
                ["contents:read"],
                "test-owner"
            );
            expect(result.token).toBe("ghs_final_token");
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("throws when resolveInstallationId fails", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            await expect(
                app.requestToken(["contents:read"], "no-install")
            ).rejects.toThrow(/not installed/i);
        });
    });

    describe("ensureRepoExists", () => {
        it("returns true when repo already exists", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(jsonResponse({ name: "existing-repo" }));
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists("myorg", "existing-repo");
            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        it("creates a new repo for an org owner", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(jsonResponse({ login: "myorg" }))
                .mockResolvedValueOnce(
                    jsonResponse(
                        { name: "new-repo", full_name: "myorg/new-repo" },
                        201
                    )
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists(
                "myorg",
                "new-repo",
                true
            );
            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(6);
        });

        it("creates a new repo for a user owner", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 20, account: { login: "myuser" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse(
                        { name: "user-repo", full_name: "myuser/user-repo" },
                        201
                    )
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists(
                "myuser",
                "user-repo",
                true
            );
            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(6);
            expect(mockFetch.mock.calls[5]![0] as string).toContain(
                "/user/repos"
            );
        });

        it("throws on repo check error (non-404) without leaking body", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Server error" }, 500)
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.ensureRepoExists("myorg", "error-repo");
            } catch (e) {
                thrown = e as Error;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toMatch(/failed to check repo existence/i);
            expect(thrown!.message).not.toContain("Server error");
        });

        it("throws on repo creation failure without leaking body", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(jsonResponse({ login: "myorg" }))
                .mockResolvedValueOnce(
                    jsonResponse(
                        { message: "Validation failed", errors: [] },
                        422
                    )
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.ensureRepoExists("myorg", "failing-repo", true);
            } catch (e) {
                if (e instanceof Error) thrown = e;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toMatch(/failed to create repo/i);
            expect(thrown!.message).not.toContain("Validation failed");
        });

        it("throws 'Repository not found' when allowCreate is false and repo does not exist", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.ensureRepoExists("myorg", "missing-repo", false);
            } catch (e) {
                if (e instanceof Error) thrown = e;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toContain("Repository not found");
        });

        it("creates a repo when allowCreate is true and repo does not exist", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                .mockResolvedValueOnce(jsonResponse({ login: "myorg" }))
                .mockResolvedValueOnce(
                    jsonResponse(
                        { name: "new-repo", full_name: "myorg/new-repo" },
                        201
                    )
                );
            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists(
                "myorg",
                "new-repo",
                true
            );
            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(6);
        });
    });
});
