import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";
import { ConsentOwnershipError } from "@/errors";

describe("TokenService — revoke", () => {
    let kv: KVNamespace;
    let service: TokenService;

    beforeEach(async () => {
        kv = env.KV;
        const { keys } = await kv.list();
        await Promise.all(keys.map((k) => kv.delete(k.name)));
        service = new TokenService(kv);
    });

    describe("revokeAllConsentsForRepo", () => {
        it("revokes all consents for a given repo", async () => {
            await service.recordConsent("test-agent", "target/repo", ["contents:read"]);
            await service.recordConsent("test-agent", "target/repo", ["contents:write"]);
            await service.recordConsent("test-agent", "other/repo", ["contents:read"]);
            await service.revokeAllConsentsForRepo("target/repo", "test-agent");

            expect(await service.checkConsent("test-agent", "target/repo", ["contents:read"])).toBe(false);
            expect(await service.checkConsent("test-agent", "target/repo", ["contents:write"])).toBe(false);
            expect(await service.checkConsent("test-agent", "other/repo", ["contents:read"])).toBe(true);
        });

        it("does nothing when repo has no consents", async () => {
            await service.recordConsent("test-agent", "other/repo", ["contents:read"]);
            await service.revokeAllConsentsForRepo("nonexistent/repo", "test-agent");
            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
        });

        it("revokes consents from all agents when agentId is not provided", async () => {
            await service.recordConsent("agent-1", "shared/repo", ["contents:read"], undefined, "userA");
            await service.recordConsent("agent-2", "shared/repo", ["contents:write"], undefined, "userB");
            await service.recordConsent("agent-1", "other/repo", ["contents:read"]);
            await service.revokeAllConsentsForRepo("shared/repo");

            expect(await service.checkConsent("agent-1", "shared/repo", ["contents:read"])).toBe(false);
            expect(await service.checkConsent("agent-2", "shared/repo", ["contents:write"])).toBe(false);
            expect(await service.checkConsent("agent-1", "other/repo", ["contents:read"])).toBe(true);
        });

        it("does not delete token cache keys for unrelated repos in cross-agent revoke", async () => {
            await service.recordConsent("agent-1", "shared/repo", ["contents:read"]);
            const future = new Date(Date.now() + 3600000).toISOString();
            await service.cacheToken("agent-1", "shared/repo", ["contents:read"], "ghs_shared", future);
            await service.recordConsent("agent-1", "other/repo", ["contents:read"]);
            await service.cacheToken("agent-1", "other/repo", ["contents:read"], "ghs_other", future);
            await service.revokeAllConsentsForRepo("shared/repo");

            const cachedOther = await service.getCachedToken("agent-1", "other/repo", ["contents:read"]);
            expect(cachedOther).not.toBeNull();
            expect(cachedOther!.token).toBe("ghs_other");

            const cachedShared = await service.getCachedToken("agent-1", "shared/repo", ["contents:read"]);
            expect(cachedShared).toBeNull();
        });
    });

    describe("revokeConsent with caller check", () => {
        it("succeeds when caller matches granted_by", async () => {
            await service.recordConsent("agent-a", "alpha/repo", ["contents:read"], undefined, "userA");
            await expect(service.revokeConsent("agent-a", "alpha/repo", ["contents:read"], "userA")).resolves.toBeUndefined();
            expect(await service.checkConsent("agent-a", "alpha/repo", ["contents:read"])).toBe(false);
        });

        it("throws ConsentOwnershipError when caller does not match granted_by", async () => {
            await service.recordConsent("agent-a", "alpha/repo", ["contents:read"], undefined, "userA");
            await expect(service.revokeConsent("agent-a", "alpha/repo", ["contents:read"], "userB")).rejects.toThrow(ConsentOwnershipError);
        });

        it("succeeds when record has no granted_by (old format, caller provided)", async () => {
            await service.recordConsent("agent-a", "legacy/repo", ["contents:read"]);
            await expect(service.revokeConsent("agent-a", "legacy/repo", ["contents:read"], "anyone")).resolves.toBeUndefined();
        });

        it("succeeds when caller is not provided (backward compat)", async () => {
            await service.recordConsent("agent-a", "alpha/repo", ["contents:read"], undefined, "userA");
            await expect(service.revokeConsent("agent-a", "alpha/repo", ["contents:read"])).resolves.toBeUndefined();
            expect(await service.checkConsent("agent-a", "alpha/repo", ["contents:read"])).toBe(false);
        });
    });
});
