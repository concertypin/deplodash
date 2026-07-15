import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";

describe("findConsentScopes — Granular Scopes & Edge Cases", () => {
    let service: TokenService;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        service = new TokenService(env.KV);
    });

    it("returns exact match when hash matches (fast path)", async () => {
        await service.recordConsent("agent-a", "repo/one", [
            "contents:read",
            "issues:read",
        ]);
        const result = await service.findConsentScopes("agent-a", "repo/one", [
            "contents:read",
            "issues:read",
        ]);
        expect(result).toEqual(["contents:read", "issues:read"]);
    });

    it("returns subset when exact hash misses but union-intersect matches", async () => {
        await service.recordConsent("agent-a", "repo/two", [
            "contents:read",
            "issues:write",
        ]);
        const result = await service.findConsentScopes("agent-a", "repo/two", [
            "contents:read",
        ]);
        expect(result).toEqual(["contents:read"]);
    });

    it("returns null when no overlap between requested and approved scopes", async () => {
        await service.recordConsent("agent-a", "repo/three", [
            "contents:read",
            "issues:read",
        ]);
        const result = await service.findConsentScopes(
            "agent-a",
            "repo/three",
            ["admin"]
        );
        expect(result).toBeNull();
    });

    it("returns union of scopes across multiple consent records for same repo", async () => {
        await service.recordConsent("agent-a", "repo/four", ["contents:read"]);
        await service.recordConsent("agent-a", "repo/four", ["issues:write"]);
        const result = await service.findConsentScopes("agent-a", "repo/four", [
            "contents:read",
            "issues:write",
        ]);
        expect(result).toContain("contents:read");
        expect(result).toContain("issues:write");
    });

    it("returns null for scopes not matching when no consent exists at all", async () => {
        const result = await service.findConsentScopes("ghost", "no/consent", [
            "contents:read",
        ]);
        expect(result).toBeNull();
    });

    it("handles empty scope list gracefully", async () => {
        await service.recordConsent("agent-a", "repo/empty", ["contents:read"]);
        const result = await service.findConsentScopes(
            "agent-a",
            "repo/empty",
            []
        );
        expect(result).toBeNull();
    });
});
