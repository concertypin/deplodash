import { describe, it, expect, beforeEach } from "vitest";
import { TokenService } from "@/token-service";
import { mockKVNamespace } from "../helpers";

describe("TokenService", () => {
    let kv: KVNamespace;
    let service: TokenService;

    beforeEach(() => {
        kv = mockKVNamespace();
        service = new TokenService(kv);
    });

    describe("consent", () => {
        it("returns false when no consent exists", async () => {
            const result = await service.checkConsent("owner/repo", [
                "contents:read",
            ]);
            expect(result).toBe(false);
        });

        it("returns true after recording consent", async () => {
            await service.recordConsent("owner/repo", ["contents:read"]);
            const result = await service.checkConsent("owner/repo", [
                "contents:read",
            ]);
            expect(result).toBe(true);
        });

        it("returns false for different scopes after recording consent", async () => {
            await service.recordConsent("owner/repo", ["contents:read"]);
            const result = await service.checkConsent("owner/repo", [
                "contents:write",
            ]);
            expect(result).toBe(false);
        });

        it("returns false after revoking consent", async () => {
            await service.recordConsent("owner/repo", ["contents:read"]);
            await service.revokeConsent("owner/repo", ["contents:read"]);
            const result = await service.checkConsent("owner/repo", [
                "contents:read",
            ]);
            expect(result).toBe(false);
        });
    });

    describe("token caching", () => {
        it("returns null when no cached token exists", async () => {
            const result = await service.getCachedToken("owner/repo", [
                "contents:read",
            ]);
            expect(result).toBeNull();
        });

        it("returns cached token after caching", async () => {
            const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            await service.cacheToken(
                "owner/repo",
                ["contents:read"],
                "ghs_test",
                future
            );
            const cached = await service.getCachedToken("owner/repo", [
                "contents:read",
            ]);
            expect(cached).not.toBeNull();
            expect(cached!.token).toBe("ghs_test");
        });

        it("returns null for expired cached token", async () => {
            const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            await service.cacheToken(
                "owner/repo",
                ["contents:read"],
                "ghs_test",
                past
            );
            const cached = await service.getCachedToken("owner/repo", [
                "contents:read",
            ]);
            expect(cached).toBeNull();
        });
    });

    describe("requestToken", () => {
        it("returns needs_consent when no consent exists and no cache", async () => {
            const result = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                },
                () =>
                    Promise.resolve({
                        token: "ghs_test",
                        expires_at: new Date(
                            Date.now() + 3600000
                        ).toISOString(),
                    })
            );
            expect(result.status).toBe("needs_consent");
            expect(result).toHaveProperty("url");
            expect((result as { url: string }).url).toContain("/auth/consent");
            expect((result as { url: string }).url).toContain("owner%2Frepo");
        });

        it("returns ok when consent exists", async () => {
            await service.recordConsent("owner/repo", ["contents:read"]);
            const result = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                },
                () =>
                    Promise.resolve({
                        token: "ghs_test",
                        expires_at: new Date(
                            Date.now() + 3600000
                        ).toISOString(),
                    })
            );
            expect(result.status).toBe("ok");
            expect((result as { token: string }).token).toBe("ghs_test");
        });

        it("returns cached token on subsequent calls", async () => {
            await service.recordConsent("owner/repo", ["contents:read"]);
            let callCount = 0;
            const getToken = () => {
                callCount++;
                return Promise.resolve({
                    token: `ghs_${callCount}`,
                    expires_at: new Date(Date.now() + 3600000).toISOString(),
                });
            };

            // First call: fetches token
            const first = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                },
                getToken
            );
            expect(first.status).toBe("ok");
            expect((first as { token: string }).token).toBe("ghs_1");

            // Second call: uses cache
            const second = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                },
                getToken
            );
            expect(second.status).toBe("ok");
            expect((second as { token: string }).token).toBe("ghs_1"); // Same cached value

            expect(callCount).toBe(1); // getToken only called once
        });
    });
});
