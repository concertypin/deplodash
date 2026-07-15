import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";

describe("Token Cache Cross-Agent Isolation", () => {
    let service: TokenService;

    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
        service = new TokenService(env.KV);
    });

    it("getCachedToken returns null for agent that did not cache the token", async () => {
        const future = new Date(Date.now() + 3600_000).toISOString();
        await service.cacheToken(
            "agent-a",
            "shared/repo",
            ["contents:read"],
            "ghs_alpha_token",
            future
        );

        const cachedB = await service.getCachedToken("agent-b", "shared/repo", [
            "contents:read",
        ]);
        expect(cachedB).toBeNull();

        const cachedA = await service.getCachedToken("agent-a", "shared/repo", [
            "contents:read",
        ]);
        expect(cachedA).not.toBeNull();
        expect(cachedA!.token).toBe("ghs_alpha_token");
    });

    it("requestToken with mismatched agent does not use another agent's cached token", async () => {
        await service.recordConsent("agent-a", "shared/repo", [
            "contents:read",
        ]);
        const future = new Date(Date.now() + 3600_000).toISOString();
        await service.cacheToken(
            "agent-a",
            "shared/repo",
            ["contents:read"],
            "ghs_alpha_token",
            future
        );

        let callCount = 0;
        const getToken = () => {
            callCount++;
            return Promise.resolve({
                token: `ghs_new_${callCount}`,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
            });
        };

        const resultB = await service.requestToken(
            {
                repo: "shared/repo",
                scopes: ["contents:read"],
                baseUrl: "http://test",
                agentId: "agent-b",
            },
            getToken
        );
        expect(resultB.status).toBe("needs_consent");
        expect(callCount).toBe(0);
    });
});
