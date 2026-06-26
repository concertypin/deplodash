import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";
import { ConsentOwnershipError } from "@/errors";

describe("Consent Ownership — Cross-User Revocation Prevention", () => {
    let service: TokenService;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        service = new TokenService(env.KV);
    });

    it("revokeConsent throws ConsentOwnershipError when caller does not match granted_by with mixed-case login", async () => {
        await service.recordConsent("agent-a", "repo/alpha", ["contents:read"], undefined, "UserA");
        await expect(service.revokeConsent("agent-a", "repo/alpha", ["contents:read"], "userA")).rejects.toThrow(ConsentOwnershipError);
    });

    it("revokeConsent succeeds for the exact matching user", async () => {
        await service.recordConsent("agent-a", "repo/alpha", ["contents:read"], undefined, "UserA");
        await expect(service.revokeConsent("agent-a", "repo/alpha", ["contents:read"], "UserA")).resolves.toBeUndefined();
    });

    it("revokeConsent with caller succeeds on records without granted_by (old format)", async () => {
        await service.recordConsent("agent-a", "legacy/repo", ["contents:read"]);
        await expect(service.revokeConsent("agent-a", "legacy/repo", ["contents:read"], "anyone")).resolves.toBeUndefined();
        expect(await service.checkConsent("agent-a", "legacy/repo", ["contents:read"])).toBe(false);
    });

    it("revokeConsent denies cross-user even with multiple agents on same repo", async () => {
        await service.recordConsent("agent-a", "shared/repo", ["contents:read"], undefined, "UserA");
        await service.recordConsent("agent-b", "shared/repo", ["contents:write"], undefined, "UserB");
        await expect(service.revokeConsent("agent-a", "shared/repo", ["contents:read"], "UserB")).rejects.toThrow(ConsentOwnershipError);
    });
});
