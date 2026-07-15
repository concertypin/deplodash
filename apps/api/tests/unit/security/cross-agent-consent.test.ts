import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";

describe("Cross-Agent Consent Boundaries (Privilege Escalation)", () => {
    let service: TokenService;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        service = new TokenService(env.KV);
    });

    it("checkConsent rejects agent with no consent when another agent has consent", async () => {
        await service.recordConsent("victim", "owner/repo", ["contents:read"]);
        const result = await service.checkConsent("malicious", "owner/repo", [
            "contents:read",
        ]);
        expect(result).toBe(false);
    });

    it("findConsentScopes returns null for agent that has no consents on the repo", async () => {
        await service.recordConsent("victim", "owner/repo", ["contents:read"]);
        const result = await service.findConsentScopes(
            "malicious",
            "owner/repo",
            ["contents:read"]
        );
        expect(result).toBeNull();
    });

    it("findConsentScopes returns null when no agent has any consents at all", async () => {
        const result = await service.findConsentScopes(
            "any-agent",
            "some/repo",
            ["contents:read"]
        );
        expect(result).toBeNull();
    });

    it("findConsentScopes respects agent isolation with multiple agents on same repo", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        await service.recordConsent("beta", "shared/repo", ["issues:write"]);

        expect(
            await service.findConsentScopes("alpha", "shared/repo", [
                "contents:read",
            ])
        ).toEqual(["contents:read"]);
        expect(
            await service.findConsentScopes("alpha", "shared/repo", [
                "issues:write",
            ])
        ).toBeNull();
        expect(
            await service.findConsentScopes("beta", "shared/repo", [
                "issues:write",
            ])
        ).toEqual(["issues:write"]);
        expect(
            await service.findConsentScopes("beta", "shared/repo", [
                "contents:read",
            ])
        ).toBeNull();
    });

    it("getAllApprovedScopes returns empty for agent with no consents, even if other agents have consents", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        const result = await service.getAllApprovedScopes(
            "other-agent",
            "shared/repo"
        );
        expect(result).toEqual([]);
    });

    it("revokeConsent does not affect other agents' consents on same repo", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        await service.recordConsent("beta", "shared/repo", ["contents:write"]);
        await service.revokeConsent("alpha", "shared/repo", ["contents:read"]);

        expect(
            await service.checkConsent("beta", "shared/repo", [
                "contents:write",
            ])
        ).toBe(true);
        expect(
            await service.checkConsent("alpha", "shared/repo", [
                "contents:read",
            ])
        ).toBe(false);
    });

    it("revokeAllConsentsForRepo with agentId only revokes that agent's consents", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        await service.recordConsent("beta", "shared/repo", ["contents:write"]);
        await service.recordConsent("alpha", "other/repo", ["contents:read"]);
        await service.revokeAllConsentsForRepo("shared/repo", "alpha");

        expect(
            await service.checkConsent("alpha", "shared/repo", [
                "contents:read",
            ])
        ).toBe(false);
        expect(
            await service.checkConsent("beta", "shared/repo", [
                "contents:write",
            ])
        ).toBe(true);
        expect(
            await service.checkConsent("alpha", "other/repo", ["contents:read"])
        ).toBe(true);
    });
});
