import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";

describe("Repo Name Collision Safety in revokeAllConsentsForRepo", () => {
    let service: TokenService;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        service = new TokenService(env.KV);
    });

    it("does not revoke consents for repo names sharing a prefix", async () => {
        await service.recordConsent("agent-a", "org/my", ["contents:read"]);
        await service.recordConsent("agent-a", "org/my-other", ["contents:write"]);
        await service.recordConsent("agent-a", "org/myrepo", ["issues:read"]);
        await service.revokeAllConsentsForRepo("org/my");

        expect(await service.checkConsent("agent-a", "org/my", ["contents:read"])).toBe(false);
        expect(await service.checkConsent("agent-a", "org/my-other", ["contents:write"])).toBe(true);
        expect(await service.checkConsent("agent-a", "org/myrepo", ["issues:read"])).toBe(true);
    });

    it("does not revoke consents for repos with dot-prefix similarity", async () => {
        await service.recordConsent("agent-a", "org/my.repo", ["contents:read"]);
        await service.recordConsent("agent-a", "org/my-repo", ["contents:write"]);
        await service.revokeAllConsentsForRepo("org/my.repo");

        expect(await service.checkConsent("agent-a", "org/my.repo", ["contents:read"])).toBe(false);
        expect(await service.checkConsent("agent-a", "org/my-repo", ["contents:write"])).toBe(true);
    });

    it("correctly handles cross-agent revoke with similar repo names", async () => {
        await service.recordConsent("agent-a", "org/my", ["contents:read"]);
        await service.recordConsent("agent-b", "org/mine", ["contents:write"]);
        await service.revokeAllConsentsForRepo("org/my");

        expect(await service.checkConsent("agent-a", "org/my", ["contents:read"])).toBe(false);
        expect(await service.checkConsent("agent-b", "org/mine", ["contents:write"])).toBe(true);
    });
});
