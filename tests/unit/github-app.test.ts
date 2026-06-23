import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { permissionsFromScopes, pemToCryptoKey, GitHubApp } from "@/github-app";
import { hashScopes } from "@/helpers";

describe("permissionsFromScopes", () => {
    it("returns contents:read permissions for contents:read scope", () => {
        const result = permissionsFromScopes(["contents:read"]);
        expect(result).toEqual({ metadata: "read", contents: "read" });
    });

    it("returns contents:write permissions for contents:write scope", () => {
        const result = permissionsFromScopes(["contents:write"]);
        expect(result).toEqual({ metadata: "read", contents: "write" });
    });

    it("returns combined permissions for contents:write + workflows:write", () => {
        const result = permissionsFromScopes([
            "contents:write",
            "workflows:write",
        ]);
        expect(result).toEqual({
            metadata: "read",
            contents: "write",
            workflows: "write",
        });
    });

    it("returns admin permissions for admin scope", () => {
        const result = permissionsFromScopes(["admin"]);
        expect(result).toEqual({
            metadata: "read",
            contents: "write",
            workflows: "write",
            administration: "write",
        });
    });

    it("handles unknown scope gracefully", () => {
        const result = permissionsFromScopes(["unknown:scope"]);
        expect(result).toEqual({ metadata: "read" });
    });

    it("is idempotent regardless of scope order", () => {
        const a = permissionsFromScopes(["workflows:write", "contents:write"]);
        const b = permissionsFromScopes(["contents:write", "workflows:write"]);
        expect(a).toEqual(b);
    });
});

describe("hashScopes", () => {
    it("returns a consistent hash for the same scopes", async () => {
        const a = await hashScopes(["contents:read", "contents:write"]);
        const b = await hashScopes(["contents:read", "contents:write"]);
        expect(a).toBe(b);
    });

    it("returns different hashes for different scopes", async () => {
        const a = await hashScopes(["contents:read"]);
        const b = await hashScopes(["contents:write"]);
        expect(a).not.toBe(b);
    });

    it("is order-independent", async () => {
        const a = await hashScopes(["contents:write", "contents:read"]);
        const b = await hashScopes(["contents:read", "contents:write"]);
        expect(a).toBe(b);
    });

    it("returns a short string (16 chars)", async () => {
        const hash = await hashScopes(["contents:read"]);
        expect(hash.length).toBe(16);
    });
});

// ─── RSA Key Setup ───────────────────────────────────────────────────────────

let pkcs8Pem: string;
let pkcs1Pem: string;
let bareBase64: string;

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

    // Export PKCS#8 DER
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const pkcs8Bytes = new Uint8Array(pkcs8);
    const b64 = btoa(String.fromCharCode(...pkcs8Bytes));
    const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
    pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    bareBase64 = b64;

    // Derive PKCS#1 by extracting inner key from PKCS#8 wrapper
    // PKCS#8: SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1Der } }
    let offset = 0;
    if (pkcs8Bytes[0] === 0x30) {
        offset = 2;
        if (pkcs8Bytes[1]! & 0x80) {
            const lenBytes = pkcs8Bytes[1]! & 0x7f;
            offset = 2 + lenBytes;
        }
    }
    // Skip version (INTEGER 0): 02 01 00
    offset += 3;
    // Skip algorithmIdentifier SEQUENCE
    if (pkcs8Bytes[offset] === 0x30) {
        offset += 2 + pkcs8Bytes[offset + 1]!;
    }
    // Read OCTET STRING header and content
    if (pkcs8Bytes[offset] === 0x04) {
        offset += 1;
        let innerLen = pkcs8Bytes[offset]!;
        if (innerLen & 0x80) {
            const numBytes = innerLen & 0x7f;
            let len = 0;
            for (let i = 0; i < numBytes; i++) {
                len = (len << 8) | pkcs8Bytes[offset + 1 + i]!;
            }
            innerLen = len;
            offset += 1 + numBytes;
        } else {
            offset += 1;
        }
    }
    const pkcs1Bytes = pkcs8Bytes.slice(offset);
    const pkcs1B64 = btoa(String.fromCharCode(...pkcs1Bytes));
    const pkcs1Lines = pkcs1B64.match(/.{1,64}/g)?.join("\n") ?? pkcs1B64;
    pkcs1Pem = `-----BEGIN RSA PRIVATE KEY-----\n${pkcs1Lines}\n-----END RSA PRIVATE KEY-----`;
});

describe("pemToCryptoKey", () => {
    it("accepts a PKCS#8 PEM string", async () => {
        const key = await pemToCryptoKey(pkcs8Pem);
        expect(key).toBeDefined();
        expect((key.algorithm as RsaHashedKeyAlgorithm).name).toBe(
            "RSASSA-PKCS1-v1_5"
        );
        expect(key.type).toBe("private");
    });

    it("accepts a PKCS#1 PEM string (auto-converts to PKCS#8)", async () => {
        const key = await pemToCryptoKey(pkcs1Pem);
        expect(key).toBeDefined();
        expect((key.algorithm as RsaHashedKeyAlgorithm).name).toBe(
            "RSASSA-PKCS1-v1_5"
        );
    });

    it("accepts a base64-encoded PEM string", async () => {
        const encoded = btoa(pkcs8Pem);
        const key = await pemToCryptoKey(encoded);
        expect(key).toBeDefined();
    });

    it("accepts a bare base64 DER body", async () => {
        const key = await pemToCryptoKey(bareBase64);
        expect(key).toBeDefined();
    });

    it("throws on unrecognised format", async () => {
        await expect(pemToCryptoKey("not-a-key!")).rejects.toThrow(
            /unrecognised key format/i
        );
    });

    it("throws on empty PEM body", async () => {
        const emptyPem =
            "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----";
        await expect(pemToCryptoKey(emptyPem)).rejects.toThrow(/empty/i);
    });
});

// ─── Test helpers ────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

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
            const firstUrl = mockFetch.mock.calls[0]![0] as string;
            expect(firstUrl).toContain("/orgs/myuser/installation");
            const secondUrl = mockFetch.mock.calls[1]![0] as string;
            expect(secondUrl).toContain("/users/myuser/installation");
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
            // Only one fetch call — second returned from cache
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
            // Body content should NOT be leaked
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
            // Body content should NOT be leaked
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

        it("throws on user 404 (not installed for user account)", async () => {
            mockFetch
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                );

            const app = new GitHubApp("123456", pkcs8Pem);
            await expect(
                app.resolveInstallationId("uninstalled-user")
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
            // Both should be fetched (different owners, different cache entries)
            expect(a).toBe("10");
            expect(b).toBe("20");
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // Third call should hit cache
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

            const fetchUrl = mockFetch.mock.calls[0]![0] as string;
            expect(fetchUrl).toContain("/app/installations/42/access_tokens");
            expect(mockFetch.mock.calls[0]![1]).toMatchObject({
                method: "POST",
            });
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
            // Body content should NOT be leaked
            expect(thrown!.message).not.toContain("Bad credentials");
            expect(thrown!.message).not.toMatch(/401.*Bad/);
        });
    });

    describe("requestToken", () => {
        it("resolves installation and returns a token", async () => {
            mockFetch
                // resolveInstallationId
                .mockResolvedValueOnce(
                    jsonResponse({ id: 55, account: { login: "test-owner" } })
                )
                // getInstallationToken
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
            expect(result.expires_at).toBe("2027-06-01T00:00:00Z");
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
                // resolveInstallationId
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                // getInstallationToken (admin)
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                // repo check — already exists
                .mockResolvedValueOnce(jsonResponse({ name: "existing-repo" }));

            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists("myorg", "existing-repo");

            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        it("creates a new repo for an org owner", async () => {
            mockFetch
                // resolveInstallationId
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                // getInstallationToken (admin)
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                // repo check — 404 (does not exist)
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                // org check — 200 (is an org)
                .mockResolvedValueOnce(jsonResponse({ login: "myorg" }))
                // create repo — 201
                .mockResolvedValueOnce(
                    jsonResponse(
                        { name: "new-repo", full_name: "myorg/new-repo" },
                        201
                    )
                );

            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists("myorg", "new-repo");

            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(5);
            // Verify the create URL is the org endpoint
            const createCallUrl = mockFetch.mock.calls[4]![0] as string;
            expect(createCallUrl).toContain("/orgs/myorg/repos");
        });

        it("creates a new repo for a user owner", async () => {
            mockFetch
                // resolveInstallationId
                .mockResolvedValueOnce(
                    jsonResponse({ id: 20, account: { login: "myuser" } })
                )
                // getInstallationToken (admin)
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                // repo check — 404 (does not exist)
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                // org check — 404 (is a user, not an org)
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                // create repo — 201 (user endpoint)
                .mockResolvedValueOnce(
                    jsonResponse(
                        { name: "user-repo", full_name: "myuser/user-repo" },
                        201
                    )
                );

            const app = new GitHubApp("123456", pkcs8Pem);
            const result = await app.ensureRepoExists("myuser", "user-repo");

            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(5);
            // Verify the create URL is the user endpoint
            const createCallUrl = mockFetch.mock.calls[4]![0] as string;
            expect(createCallUrl).toContain("/user/repos");
        });

        it("throws on repo check error (non-404) without leaking body", async () => {
            mockFetch
                // resolveInstallationId
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                // getInstallationToken (admin)
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                // repo check — 500 error
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
            // Body content should NOT be leaked
            expect(thrown!.message).not.toContain("Server error");
        });

        it("throws on repo creation failure without leaking body", async () => {
            mockFetch
                // resolveInstallationId
                .mockResolvedValueOnce(
                    jsonResponse({ id: 10, account: { login: "myorg" } })
                )
                // getInstallationToken (admin)
                .mockResolvedValueOnce(
                    jsonResponse({
                        token: "admin_token",
                        expires_at: "2026-12-31T23:59:59Z",
                        permissions: { administration: "write" },
                        repository_selection: "selected",
                    })
                )
                // repo check — 404
                .mockResolvedValueOnce(
                    jsonResponse({ message: "Not found" }, 404)
                )
                // org check — 200
                .mockResolvedValueOnce(jsonResponse({ login: "myorg" }))
                // create repo — 422 validation error
                .mockResolvedValueOnce(
                    jsonResponse(
                        { message: "Validation failed", errors: [] },
                        422
                    )
                );

            const app = new GitHubApp("123456", pkcs8Pem);
            let thrown: Error | undefined;
            try {
                await app.ensureRepoExists("myorg", "failing-repo");
            } catch (e) {
                thrown = e as Error;
            }
            expect(thrown).toBeDefined();
            expect(thrown!.message).toMatch(/failed to create repo/i);
            // Body content should NOT be leaked
            expect(thrown!.message).not.toContain("Validation failed");
        });
    });
});
