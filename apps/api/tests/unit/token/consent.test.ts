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

        it("finds consent stored under the pre-normalization key casing", async () => {
            // Simulate a grant recorded before repo normalization: the KV key
            // uses the original casing "Owner/Repo".
            const scopes = ["contents:read"];
            const hash = await hashScopes(scopes);
            const legacyKey = `consent:test-agent:Owner/Repo:${hash}`;
            await kv.put(
                legacyKey,
                JSON.stringify({
                    repo: "Owner/Repo",
                    scopes: "contents:read",
                    granted_at: new Date().toISOString(),
                })
            );

            // The agent retrying with the original casing must still find the
            // pre-normalization grant (fallback to the legacy key format).
            expect(
                await service.checkConsent("test-agent", "Owner/Repo", scopes)
            ).toBe(true);
            expect(
                await service.findConsentScopes(
                    "test-agent",
                    "Owner/Repo",
                    scopes
                )
            ).toEqual(scopes);
        });

        it("finds a pre-normalization grant when retried with a different casing", async () => {
            // Grant stored under "Owner/Repo" before normalization; the agent
            // retries with "owner/repo". The exact-key fallback cannot match
            // (keys differ), so the case-insensitive prefix scan must find it.
            const scopes = ["contents:read"];
            const hash = await hashScopes(scopes);
            const legacyKey = `consent:test-agent:Owner/Repo:${hash}`;
            await kv.put(
                legacyKey,
                JSON.stringify({
                    repo: "Owner/Repo",
                    scopes: "contents:read",
                    granted_at: new Date().toISOString(),
                })
            );

            expect(
                await service.checkConsent("test-agent", "owner/repo", scopes)
            ).toBe(true);
            expect(
                await service.findConsentScopes(
                    "test-agent",
                    "owner/repo",
                    scopes
                )
            ).toEqual(scopes);
            expect(
                await service.getAllApprovedScopes("test-agent", "owner/repo")
            ).toEqual(["contents:read"]);
        });

        it("revokes a pre-normalization grant when called with a different casing", async () => {
            const scopes = ["contents:read"];
            const hash = await hashScopes(scopes);
            const legacyKey = `consent:test-agent:Owner/Repo:${hash}`;
            await kv.put(
                legacyKey,
                JSON.stringify({
                    repo: "Owner/Repo",
                    scopes: "contents:read",
                    granted_at: new Date().toISOString(),
                    granted_by: "testuser",
                })
            );

            await service.revokeConsent(
                "test-agent",
                "owner/repo",
                scopes,
                "testuser"
            );
            expect(await kv.get(legacyKey)).toBeNull();
        });

        it("revokes consent stored under the pre-normalization key casing", async () => {
            const scopes = ["contents:read"];
            const hash = await hashScopes(scopes);
            const legacyKey = `consent:test-agent:Owner/Repo:${hash}`;
            await kv.put(
                legacyKey,
                JSON.stringify({
                    repo: "Owner/Repo",
                    scopes: "contents:read",
                    granted_at: new Date().toISOString(),
                    granted_by: "testuser",
                })
            );

            await service.revokeConsent(
                "test-agent",
                "Owner/Repo",
                scopes,
                "testuser"
            );
            expect(await kv.get(legacyKey)).toBeNull();
            expect(
                await service.checkConsent("test-agent", "Owner/Repo", scopes)
            ).toBe(false);
        });

        it("rejects revoking a legacy-key consent owned by another user", async () => {
            const scopes = ["contents:read"];
            const hash = await hashScopes(scopes);
            const legacyKey = `consent:test-agent:Owner/Repo:${hash}`;
            await kv.put(
                legacyKey,
                JSON.stringify({
                    repo: "Owner/Repo",
                    scopes: "contents:read",
                    granted_at: new Date().toISOString(),
                    granted_by: "someone-else",
                })
            );

            await expect(
                service.revokeConsent(
                    "test-agent",
                    "Owner/Repo",
                    scopes,
                    "testuser"
                )
            ).rejects.toThrow("You can only revoke your own consents.");
            expect(await kv.get(legacyKey)).not.toBeNull();
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
