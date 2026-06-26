import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token/service";

describe("TokenService — listConsents", () => {
    let kv: KVNamespace;
    let service: TokenService;

    beforeEach(async () => {
        kv = env.KV;
        const { keys } = await kv.list();
        await Promise.all(keys.map((k) => kv.delete(k.name)));
        service = new TokenService(kv);
    });

    it("returns empty array when no consents exist", async () => {
        const consents = await service.listConsents();
        expect(consents).toEqual([]);
    });

    it("returns a single consent record", async () => {
        await service.recordConsent("test-agent", "alpha/repo", ["contents:read"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.repo).toBe("alpha/repo");
        expect(consents[0]!.scopes).toBe("contents:read");
        expect(consents[0]!.granted_at).toBeTruthy();
    });

    it("includes granted_by in listConsents when set", async () => {
        await service.recordConsent("test-agent", "alpha/repo", ["contents:read"], undefined, "testuser");
        const consents = await service.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.granted_by).toBe("testuser");
    });

    it("omits granted_by in listConsents when not set", async () => {
        await service.recordConsent("test-agent", "alpha/repo", ["contents:read"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.granted_by).toBeUndefined();
    });

    it("includes agent_id in listConsents when set", async () => {
        await service.recordConsent("test-agent", "alpha/repo", ["contents:read"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.agent_id).toBe("test-agent");
    });

    it("returns multiple consent records", async () => {
        await service.recordConsent("test-agent", "alpha/repo", ["contents:read"]);
        await service.recordConsent("test-agent", "beta/repo", ["contents:write"]);
        await service.recordConsent("test-agent", "gamma/repo", ["admin"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(3);
        const repos = consents.map((c) => c.repo).sort();
        expect(repos).toEqual(["alpha/repo", "beta/repo", "gamma/repo"]);
    });

    it("sorts results by granted_at descending (newest first)", async () => {
        await service.recordConsent("test-agent", "old/repo", ["contents:read"]);
        await new Promise((r) => setTimeout(r, 50));
        await service.recordConsent("test-agent", "new/repo", ["contents:write"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(2);
        expect(consents[0]!.repo).toBe("new/repo");
        expect(consents[1]!.repo).toBe("old/repo");
    });

    it("handles old-format consent records without repo/scopes fields", async () => {
        await kv.put("consent:legacy/repo:abc123", JSON.stringify({ granted_at: "2026-01-01T00:00:00Z" }));
        await service.recordConsent("test-agent", "new/repo", ["contents:read"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.repo).toBe("new/repo");
    });

    it("skips consent records with missing required fields", async () => {
        await kv.put("consent:orphan:hash1", JSON.stringify({ some_other_field: true }));
        await service.recordConsent("test-agent", "valid/repo", ["contents:read"]);
        const consents = await service.listConsents();
        expect(consents).toHaveLength(1);
        expect(consents[0]!.repo).toBe("valid/repo");
    });

    describe("with grantedBy filter", () => {
        it("returns only consents granted by the specified user", async () => {
            await service.recordConsent("agent-a", "alpha/repo", ["contents:read"], undefined, "userA");
            await service.recordConsent("agent-b", "beta/repo", ["contents:write"], undefined, "userB");
            const userAConsents = await service.listConsents("userA");
            expect(userAConsents).toHaveLength(1);
            expect(userAConsents[0]!.repo).toBe("alpha/repo");
            const userBConsents = await service.listConsents("userB");
            expect(userBConsents).toHaveLength(1);
            expect(userBConsents[0]!.repo).toBe("beta/repo");
        });

        it("returns empty array when specified user has no consents", async () => {
            await service.recordConsent("agent-a", "alpha/repo", ["contents:read"], undefined, "userA");
            const consents = await service.listConsents("nobody");
            expect(consents).toEqual([]);
        });

        it("excludes records without granted_by when filter is active", async () => {
            await service.recordConsent("agent-a", "legacy/repo", ["contents:read"]);
            await service.recordConsent("agent-b", "owned/repo", ["contents:write"], undefined, "userA");
            const consents = await service.listConsents("userA");
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("owned/repo");
        });

        it("returns all records when filter is not provided (backward compat)", async () => {
            await service.recordConsent("agent-a", "alpha/repo", ["contents:read"], undefined, "userA");
            await service.recordConsent("agent-b", "beta/repo", ["contents:write"], undefined, "userB");
            await service.recordConsent("agent-c", "legacy/repo", ["contents:read"]);
            const all = await service.listConsents();
            expect(all).toHaveLength(3);
        });
    });
});
