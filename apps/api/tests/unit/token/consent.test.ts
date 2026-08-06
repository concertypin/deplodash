import { describe, it, expect, beforeEach } from "vitest";
import { FakeKV } from "@tests/helpers";
import { TokenService } from "@/token/service";
import { hashScopes } from "@/github/scopes";

describe("TokenService — consent", () => {
    let kv: FakeKV;
    let service: TokenService;
    beforeEach(() => {
        kv = new FakeKV();
        service = new TokenService(kv as unknown as KVNamespace);
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
            // Insert a schema-violating (but JSON-parseable) record so
            // requestToken exercises the malformed-record cleanup path
            // (not just an empty namespace).
            await kv.put(key, JSON.stringify({ unexpected: "shape" }));

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

            const consents = await service.listConsents();
            expect(consents).toHaveLength(1);
            expect(consents[0]!.repo).toBe("owner/repo");
        });
    });

    it("includes granted_at for every consent entry to ensure unique each-block keys", async () => {
        await service.recordConsent("agent-a", "owner/repo", ["contents:read"]);
        await service.recordConsent("agent-b", "owner/repo", ["contents:read"]);

        const consents = await service.listConsents();
        expect(consents).toHaveLength(2);
        for (const entry of consents) {
            expect(entry.granted_at).toBeTruthy();
            expect(typeof entry.granted_at).toBe("string");
        }

        // Key composite must be unique for entries with the same repo + agent_id
        const keys = consents.map(
            (e) => `${e.repo}|${e.agent_id ?? ""}|${e.granted_at}`
        );
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("uses the newest granted_at when consent records overlap a scope", async () => {
        const prefix = "consent:test-agent:owner/repo:";
        await kv.put(
            `${prefix}aaa`,
            JSON.stringify({
                repo: "owner/repo",
                scopes: "contents:read",
                granted_at: "2026-02-01T00:00:00.000Z",
                repo_mode: "create-if-missing",
            })
        );
        await kv.put(
            `${prefix}zzz`,
            JSON.stringify({
                repo: "owner/repo",
                scopes: "contents:read",
                granted_at: "2026-03-01T00:00:00.000Z",
                repo_mode: "existing-only",
            })
        );

        const mode = await service.getConsentRepositoryMode(
            "test-agent",
            "owner/repo",
            ["contents:read"]
        );

        expect(mode).toBe("existing-only");
    });
});
