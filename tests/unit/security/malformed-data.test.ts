import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";
import { hashScopes } from "@/github/scopes";

describe("Malformed Data Attack Surface", () => {
    let service: TokenService;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        service = new TokenService(env.KV);
    });

    it("getAllApprovedScopes ignores malformed consent records", async () => {
        await service.recordConsent("agent-a", "repo/valid", ["contents:read"]);
        await env.KV.put(
            "consent:agent-a:repo/valid:badhash1",
            JSON.stringify({
                repo: "repo/valid",
                granted_at: "2026-01-01T00:00:00Z",
            })
        );
        await env.KV.put(
            "consent:agent-a:repo/valid:badhash2",
            JSON.stringify({ foo: "bar" })
        );

        const scopes = await service.getAllApprovedScopes(
            "agent-a",
            "repo/valid"
        );
        expect(scopes).toEqual(["contents:read"]);
    });

    it("checkConsent returns false when consent record is malformed", async () => {
        const hash = await hashScopes(["contents:read"]);
        const key = `consent:agent-a:repo/malformed:${hash}`;
        await env.KV.put(
            key,
            JSON.stringify({ granted_at: "2026-01-01T00:00:00Z" })
        );

        const result = await service.checkConsent("agent-a", "repo/malformed", [
            "contents:read",
        ]);
        expect(result).toBe(false);
    });

    it("malformed consent record is cleaned up when encountered through requestToken", async () => {
        const hash = await hashScopes(["contents:read"]);
        const key = `consent:agent-a:repo/cleanup:${hash}`;
        await env.KV.put(
            key,
            JSON.stringify({
                granted_at: "2026-01-01T00:00:00Z",
                repo: "repo/cleanup",
            })
        );

        const result = await service.requestToken(
            {
                repo: "repo/cleanup",
                scopes: ["contents:read"],
                baseUrl: "http://test",
                agentId: "agent-a",
            },
            () =>
                Promise.resolve({
                    token: "ghs_test",
                    expires_at: new Date(Date.now() + 3600000).toISOString(),
                })
        );
        expect(result.status).toBe("needs_consent");

        const stillExists = await env.KV.get(key);
        expect(stillExists).toBeNull();
    });
});
