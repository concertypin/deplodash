import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { OidcConsentService } from "@/oidc/consent";
import { parseAudience } from "@/oidc/audience";
import { clearKV } from "@tests/helpers";

const AUD_A = parseAudience(
    "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool-a/providers/prov-a"
)!;
const AUD_B = parseAudience(
    "https://iam.googleapis.com/projects/2/locations/global/workloadIdentityPools/pool-b/providers/prov-b"
)!;
const UID_1 = "uid1uid1uid1uid1uid1u1";
const UID_2 = "uid2uid2uid2uid2uid2u2";

describe("OidcConsentService", () => {
    const service = new OidcConsentService(env.KV);

    beforeEach(async () => {
        await clearKV(env.KV);
    });

    it("has no consent until one is granted", async () => {
        expect(await service.hasConsent(UID_1, AUD_A.audience)).toBe(false);
        await service.grant({
            agentId: "agent-1",
            agentUid: UID_1,
            audience: AUD_A,
            grantedBy: "owner",
        });
        expect(await service.hasConsent(UID_1, AUD_A.audience)).toBe(true);
    });

    it("scopes consent to one agent uid and one audience", async () => {
        await service.grant({
            agentId: "agent-1",
            agentUid: UID_1,
            audience: AUD_A,
            grantedBy: "owner",
        });
        expect(await service.hasConsent(UID_2, AUD_A.audience)).toBe(false);
        expect(await service.hasConsent(UID_1, AUD_B.audience)).toBe(false);
    });

    it("rejects a record whose stored audience does not match the key", async () => {
        await service.grant({
            agentId: "agent-1",
            agentUid: UID_1,
            audience: AUD_A,
            grantedBy: "owner",
        });
        // Tamper: overwrite AUD_A's record with one naming AUD_B. The key
        // alone must not be trusted; the stored audience has to match.
        const [key] = (await env.KV.list({ prefix: "oidc_consent:" })).keys;
        await env.KV.put(
            key!.name,
            JSON.stringify({
                agent_id: "agent-1",
                agent_uid: UID_1,
                audience: AUD_B.audience,
                provider: "gcp",
                granted_by: "owner",
                granted_at: new Date().toISOString(),
            })
        );
        expect(await service.hasConsent(UID_1, AUD_A.audience)).toBe(false);
    });

    it("ignores malformed records", async () => {
        await service.grant({
            agentId: "agent-1",
            agentUid: UID_1,
            audience: AUD_A,
            grantedBy: "owner",
        });
        const [key] = (await env.KV.list({ prefix: "oidc_consent:" })).keys;
        await env.KV.put(
            key!.name,
            JSON.stringify({ audience: AUD_A.audience })
        );
        expect(await service.hasConsent(UID_1, AUD_A.audience)).toBe(false);
        expect(await service.listForAgent(UID_1)).toEqual([]);
    });

    it("lists, revokes one, and revokes all of an agent's consents", async () => {
        for (const audience of [AUD_A, AUD_B]) {
            await service.grant({
                agentId: "agent-1",
                agentUid: UID_1,
                audience,
                grantedBy: "owner",
            });
        }
        await service.grant({
            agentId: "agent-2",
            agentUid: UID_2,
            audience: AUD_A,
            grantedBy: "owner",
        });

        const listed = await service.listForAgent(UID_1);
        expect(listed.map((r) => r.audience).sort()).toEqual(
            [AUD_A.audience, AUD_B.audience].sort()
        );
        expect(listed[0]).toMatchObject({
            agent_id: "agent-1",
            agent_uid: UID_1,
            provider: "gcp",
            granted_by: "owner",
        });

        await service.revoke(UID_1, AUD_A.audience);
        expect(await service.hasConsent(UID_1, AUD_A.audience)).toBe(false);
        expect(await service.hasConsent(UID_1, AUD_B.audience)).toBe(true);

        await service.revokeAll(UID_1);
        expect(await service.listForAgent(UID_1)).toEqual([]);
        // Another agent's consent is untouched.
        expect(await service.hasConsent(UID_2, AUD_A.audience)).toBe(true);
    });
});
