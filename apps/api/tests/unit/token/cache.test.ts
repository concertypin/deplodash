import { describe, it, expect, beforeEach } from "vitest";
import { FakeKV } from "../../helpers";
import { TokenService } from "@/token/service";

describe("TokenService — cache & requestToken", () => {
    let kv: FakeKV;
    let service: TokenService;

    beforeEach(() => {
        kv = new FakeKV();
        service = new TokenService(kv as unknown as KVNamespace);
    });

    describe("token caching", () => {
        it("returns null when no cached token exists", async () => {
            const result = await service.getCachedToken(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(result).toBeNull();
        });

        it("returns cached token after caching", async () => {
            const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            await service.cacheToken(
                "test-agent",
                "owner/repo",
                ["contents:read"],
                "ghs_test",
                future
            );
            const cached = await service.getCachedToken(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(cached).not.toBeNull();
            expect(cached!.token).toBe("ghs_test");
        });

        it("returns null for expired cached token", async () => {
            const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            await service.cacheToken(
                "test-agent",
                "owner/repo",
                ["contents:read"],
                "ghs_test",
                past
            );
            const cached = await service.getCachedToken(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(cached).toBeNull();
        });

        it("does not cache token that is too close to expiry", async () => {
            const nearExpiry = new Date(
                Date.now() + 4 * 60 * 1000
            ).toISOString();
            await service.cacheToken(
                "test-agent",
                "owner/repo",
                ["contents:read"],
                "ghs_near_expiry",
                nearExpiry
            );
            const cached = await service.getCachedToken(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(cached).toBeNull();
        });

        it("caches token with 1 hour max TTL", async () => {
            const farFuture = new Date(
                Date.now() + 24 * 60 * 60 * 1000
            ).toISOString();
            await service.cacheToken(
                "test-agent",
                "owner/repo",
                ["contents:read"],
                "ghs_long",
                farFuture
            );
            const cached = await service.getCachedToken(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(cached).not.toBeNull();
            expect(cached!.token).toBe("ghs_long");
        });
    });

    describe("requestToken", () => {
        it("returns needs_consent when no consent exists and no cache", async () => {
            const result = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                    agentId: "test-agent",
                    encryptionSecret: "test-secret-1234567890123456",
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
            if (result.status !== "needs_consent") return;
            expect(result.url).toContain("/auth/consent");
            expect(result.url).toContain("owner%2Frepo");
            expect(result.url).toContain("requested_scopes_enc=");
            expect(result.url).toContain("agent_id=test-agent");
        });

        it("returns ok when consent exists", async () => {
            await service.recordConsent("test-agent", "owner/repo", [
                "contents:read",
            ]);
            const result = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                    agentId: "test-agent",
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
            await service.recordConsent("test-agent", "owner/repo", [
                "contents:read",
            ]);
            let callCount = 0;
            const getToken = () => {
                callCount++;
                return Promise.resolve({
                    token: `ghs_${callCount}`,
                    expires_at: new Date(Date.now() + 3600000).toISOString(),
                });
            };

            const first = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                    agentId: "test-agent",
                },
                getToken
            );
            expect(first.status).toBe("ok");
            if (first.status !== "ok") return;
            expect(first.token).toBe("ghs_1");

            const second = await service.requestToken(
                {
                    repo: "owner/repo",
                    scopes: ["contents:read"],
                    baseUrl: "http://test",
                    agentId: "test-agent",
                },
                getToken
            );
            expect(second.status).toBe("ok");
            if (second.status !== "ok") return;
            expect(second.token).toBe("ghs_1");
            expect(callCount).toBe(1);
        });
    });
});
