import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token-service";
import { ConsentOwnershipError } from "@/errors";
import { hashScopes } from "@/helpers";

describe("TokenService", () => {
    let kv: KVNamespace;
    let service: TokenService;

    beforeEach(async () => {
        kv = env.KV;
        // cloudflare:workers' env.KV does not auto-isolate between tests.
        // Clear all keys to give each test a clean slate.
        const { keys } = await kv.list();
        await Promise.all(keys.map((k) => kv.delete(k.name)));
        service = new TokenService(kv);
    });

    describe("consent", () => {
        it("returns false when no consent exists", async () => {
            const result = await service.checkConsent(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(result).toBe(false);
        });

        it("returns true after recording consent", async () => {
            await service.recordConsent("test-agent", "owner/repo", [
                "contents:read",
            ]);
            const result = await service.checkConsent(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(result).toBe(true);
        });

        it("returns false for different scopes after recording consent", async () => {
            await service.recordConsent("test-agent", "owner/repo", [
                "contents:read",
            ]);
            const result = await service.checkConsent(
                "test-agent",
                "owner/repo",
                ["contents:write"]
            );
            expect(result).toBe(false);
        });

        it("returns false after revoking consent", async () => {
            await service.recordConsent("test-agent", "owner/repo", [
                "contents:read",
            ]);
            await service.revokeConsent("test-agent", "owner/repo", [
                "contents:read",
            ]);
            const result = await service.checkConsent(
                "test-agent",
                "owner/repo",
                ["contents:read"]
            );
            expect(result).toBe(false);
        });

        it("deletes malformed consent records when read", async () => {
            const scopes = ["contents:read"];
            const repo = "broken/repo";
            const hash = await hashScopes(scopes);
            const key = `consent:test-agent:${repo}:${hash}`;
            await kv.put(
                key,
                JSON.stringify({
                    granted_at: "2026-06-16T12:14:54.136Z",
                })
            );

            const result = await service.requestToken(
                {
                    repo,
                    scopes,
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

            expect(result.status).toBe("needs_consent");
            if (result.status !== "needs_consent") return;
            expect(await kv.get(key)).toBeNull();
        });
    });

    describe("recordConsent with agentId", () => {
        it("stores the agent_id when provided", async () => {
            await service.recordConsent("agent-123", "owner/repo", [
                "contents:read",
            ]);
            const result = await service.checkConsent(
                "agent-123",
                "owner/repo",
                ["contents:read"]
            );
            expect(result).toBe(true);

            // Verify the agent_id is stored by listing consents
            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("owner/repo");
        });
    });

    describe("listConsents", () => {
        it("returns empty array when no consents exist", async () => {
            const consents = await service.listConsents();
            expect(consents).toEqual([]);
        });

        it("returns a single consent record", async () => {
            await service.recordConsent("test-agent", "alpha/repo", [
                "contents:read",
            ]);

            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("alpha/repo");
            expect(consents[0]!.scopes).toBe("contents:read");
            expect(consents[0]!.granted_at).toBeTruthy();
        });

        it("includes granted_by in listConsents when set", async () => {
            await service.recordConsent(
                "test-agent",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "testuser"
            );

            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.granted_by).toBe("testuser");
        });

        it("omits granted_by in listConsents when not set", async () => {
            await service.recordConsent("test-agent", "alpha/repo", [
                "contents:read",
            ]);

            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.granted_by).toBeUndefined();
        });

        it("includes agent_id in listConsents when set", async () => {
            await service.recordConsent("test-agent", "alpha/repo", [
                "contents:read",
            ]);

            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.agent_id).toBe("test-agent");
        });

        it("returns multiple consent records", async () => {
            await service.recordConsent("test-agent", "alpha/repo", [
                "contents:read",
            ]);
            await service.recordConsent("test-agent", "beta/repo", [
                "contents:write",
            ]);
            await service.recordConsent("test-agent", "gamma/repo", ["admin"]);

            const consents = await service.listConsents();
            expect(consents).toHaveLength(3);
            const repos = consents.map((c) => c.repo).sort();
            expect(repos).toEqual(["alpha/repo", "beta/repo", "gamma/repo"]);
        });

        it("sorts results by granted_at descending (newest first)", async () => {
            await service.recordConsent("test-agent", "old/repo", [
                "contents:read",
            ]);
            // Small delay to ensure different timestamps
            await new Promise((r) => setTimeout(r, 50));
            await service.recordConsent("test-agent", "new/repo", [
                "contents:write",
            ]);

            const consents = await service.listConsents();
            expect(consents).toHaveLength(2);
            expect(consents[0]!.repo).toBe("new/repo");
            expect(consents[1]!.repo).toBe("old/repo");
        });

        it("handles old-format consent records without repo/scopes fields", async () => {
            // Write a raw old-format record that has no repo/scopes fields
            await kv.put(
                "consent:legacy/repo:abc123",
                JSON.stringify({
                    granted_at: "2026-01-01T00:00:00Z",
                })
            );

            // Also write a new-format record
            await service.recordConsent("test-agent", "new/repo", [
                "contents:read",
            ]);

            const consents = await service.listConsents();
            // Old format without repo/scopes should be skipped
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("new/repo");
        });

        it("skips consent records with missing required fields", async () => {
            // Store a JSON object without repo/scopes/granted_at fields
            await kv.put(
                "consent:orphan:hash1",
                JSON.stringify({ some_other_field: true })
            );
            await service.recordConsent("test-agent", "valid/repo", [
                "contents:read",
            ]);

            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("valid/repo");
        });
    });

    describe("revokeAllConsentsForRepo", () => {
        it("revokes all consents for a given repo", async () => {
            await service.recordConsent("test-agent", "target/repo", [
                "contents:read",
            ]);
            await service.recordConsent("test-agent", "target/repo", [
                "contents:write",
            ]);
            await service.recordConsent("test-agent", "other/repo", [
                "contents:read",
            ]);

            await service.revokeAllConsentsForRepo("target/repo", "test-agent");

            const check1 = await service.checkConsent(
                "test-agent",
                "target/repo",
                ["contents:read"]
            );
            const check2 = await service.checkConsent(
                "test-agent",
                "target/repo",
                ["contents:write"]
            );
            const check3 = await service.checkConsent(
                "test-agent",
                "other/repo",
                ["contents:read"]
            );
            expect(check1).toBe(false);
            expect(check2).toBe(false);
            expect(check3).toBe(true);
        });

        it("does nothing when repo has no consents", async () => {
            await service.recordConsent("test-agent", "other/repo", [
                "contents:read",
            ]);

            await service.revokeAllConsentsForRepo(
                "nonexistent/repo",
                "test-agent"
            );

            // Other repo should be unaffected
            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
        });

        it("revokes consents from all agents when agentId is not provided", async () => {
            // Create consents for multiple agents on the same repo
            await service.recordConsent(
                "agent-1",
                "shared/repo",
                ["contents:read"],
                undefined,
                "userA"
            );
            await service.recordConsent(
                "agent-2",
                "shared/repo",
                ["contents:write"],
                undefined,
                "userB"
            );
            // Unrelated repo should be unaffected
            await service.recordConsent("agent-1", "other/repo", [
                "contents:read",
            ]);

            // Revoke without agentId (cross-agent)
            await service.revokeAllConsentsForRepo("shared/repo");

            const check1 = await service.checkConsent(
                "agent-1",
                "shared/repo",
                ["contents:read"]
            );
            const check2 = await service.checkConsent(
                "agent-2",
                "shared/repo",
                ["contents:write"]
            );
            const check3 = await service.checkConsent("agent-1", "other/repo", [
                "contents:read",
            ]);
            expect(check1).toBe(false);
            expect(check2).toBe(false);
            expect(check3).toBe(true);
        });

        it("does not delete token cache keys for unrelated repos in cross-agent revoke", async () => {
            await service.recordConsent("agent-1", "shared/repo", [
                "contents:read",
            ]);
            const future = new Date(Date.now() + 3600000).toISOString();
            await service.cacheToken(
                "agent-1",
                "shared/repo",
                ["contents:read"],
                "ghs_shared",
                future
            );
            await service.recordConsent("agent-1", "other/repo", [
                "contents:read",
            ]);
            await service.cacheToken(
                "agent-1",
                "other/repo",
                ["contents:read"],
                "ghs_other",
                future
            );

            await service.revokeAllConsentsForRepo("shared/repo");

            const cachedOther = await service.getCachedToken(
                "agent-1",
                "other/repo",
                ["contents:read"]
            );
            expect(cachedOther).not.toBeNull();
            expect(cachedOther!.token).toBe("ghs_other");

            const cachedShared = await service.getCachedToken(
                "agent-1",
                "shared/repo",
                ["contents:read"]
            );
            expect(cachedShared).toBeNull();
        });
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
            // Token expires in 4 minutes (well within 5 min safety buffer)
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
            // Token expires in 24 hours — should be capped to 1 hour
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

            // First call: fetches token
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

            // Second call: uses cache
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
            expect(second.token).toBe("ghs_1"); // Same cached value

            expect(callCount).toBe(1); // getToken only called once
        });
    });

    describe("listConsents with grantedBy filter", () => {
        it("returns only consents granted by the specified user", async () => {
            await service.recordConsent(
                "agent-a",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "userA"
            );
            await service.recordConsent(
                "agent-b",
                "beta/repo",
                ["contents:write"],
                undefined,
                "userB"
            );

            const userAConsents = await service.listConsents("userA");
            expect(userAConsents).toHaveLength(1);
            expect(userAConsents[0]!.repo).toBe("alpha/repo");

            const userBConsents = await service.listConsents("userB");
            expect(userBConsents).toHaveLength(1);
            expect(userBConsents[0]!.repo).toBe("beta/repo");
        });

        it("returns empty array when specified user has no consents", async () => {
            await service.recordConsent(
                "agent-a",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "userA"
            );

            const consents = await service.listConsents("nobody");
            expect(consents).toEqual([]);
        });

        it("excludes records without granted_by when filter is active", async () => {
            // Old-format record without granted_by
            await service.recordConsent("agent-a", "legacy/repo", [
                "contents:read",
            ]);
            await service.recordConsent(
                "agent-b",
                "owned/repo",
                ["contents:write"],
                undefined,
                "userA"
            );

            const consents = await service.listConsents("userA");
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("owned/repo");
        });

        it("returns all records when filter is not provided (backward compat)", async () => {
            await service.recordConsent(
                "agent-a",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "userA"
            );
            await service.recordConsent(
                "agent-b",
                "beta/repo",
                ["contents:write"],
                undefined,
                "userB"
            );
            await service.recordConsent("agent-c", "legacy/repo", [
                "contents:read",
            ]);

            const all = await service.listConsents();
            expect(all).toHaveLength(3);
        });
    });

    describe("revokeConsent with caller check", () => {
        it("succeeds when caller matches granted_by", async () => {
            await service.recordConsent(
                "agent-a",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "userA"
            );

            await expect(
                service.revokeConsent(
                    "agent-a",
                    "alpha/repo",
                    ["contents:read"],
                    "userA"
                )
            ).resolves.toBeUndefined();

            const check = await service.checkConsent("agent-a", "alpha/repo", [
                "contents:read",
            ]);
            expect(check).toBe(false);
        });

        it("throws ConsentOwnershipError when caller does not match granted_by", async () => {
            await service.recordConsent(
                "agent-a",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "userA"
            );

            await expect(
                service.revokeConsent(
                    "agent-a",
                    "alpha/repo",
                    ["contents:read"],
                    "userB"
                )
            ).rejects.toThrow(ConsentOwnershipError);
        });

        it("succeeds when record has no granted_by (old format, caller provided)", async () => {
            // Old format record without granted_by field
            await service.recordConsent("agent-a", "legacy/repo", [
                "contents:read",
            ]);

            await expect(
                service.revokeConsent(
                    "agent-a",
                    "legacy/repo",
                    ["contents:read"],
                    "anyone"
                )
            ).resolves.toBeUndefined();
        });

        it("succeeds when caller is not provided (backward compat)", async () => {
            await service.recordConsent(
                "agent-a",
                "alpha/repo",
                ["contents:read"],
                undefined,
                "userA"
            );

            await expect(
                service.revokeConsent("agent-a", "alpha/repo", [
                    "contents:read",
                ])
            ).resolves.toBeUndefined();

            const check = await service.checkConsent("agent-a", "alpha/repo", [
                "contents:read",
            ]);
            expect(check).toBe(false);
        });
    });
});
