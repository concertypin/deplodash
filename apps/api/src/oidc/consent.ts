/**
 * @fileoverview
 * OIDC consent records: which audiences an agent's owner approved.
 *
 * KV key layout:
 *   oidc_consent:${agentUid}:${sha256(audience)} → OidcConsentRecord
 *
 * Keyed by the agent uid (not `agent_id`) so a consent dies with the agent
 * token: an agent re-created under the same `agent_id` gets a new uid and
 * starts with no consent.
 */

import * as z from "zod";
import type { ParsedAudience } from "@/oidc/audience";

const PREFIX = "oidc_consent:";

/**
 * Wait-notifier key for an OIDC consent. The `oidc:` prefix keeps it apart
 * from repository keys (`owner/repo` never contains a colon).
 */
export function oidcWaiterKey(audience: string): string {
    return `oidc:${audience}`;
}

const recordSchema = z.object({
    agent_id: z.string().min(1),
    agent_uid: z.string().min(1),
    audience: z.string().min(1),
    provider: z.literal("gcp"),
    granted_by: z.string().min(1),
    granted_at: z.string().min(1),
});
export type OidcConsentRecord = z.infer<typeof recordSchema>;

async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value)
    );
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function consentKey(agentUid: string, audience: string): Promise<string> {
    return `${PREFIX}${agentUid}:${await sha256Hex(audience)}`;
}

export class OidcConsentService {
    constructor(private readonly kv: KVNamespace) {}

    async hasConsent(agentUid: string, audience: string): Promise<boolean> {
        const value = await this.kv.get(
            await consentKey(agentUid, audience),
            "json"
        );
        const parsed = recordSchema.safeParse(value);
        // The hash keys the record; the stored audience must match too.
        return (
            parsed.success &&
            parsed.data.agent_uid === agentUid &&
            parsed.data.audience === audience
        );
    }

    async grant(params: {
        agentId: string;
        agentUid: string;
        audience: ParsedAudience;
        grantedBy: string;
    }): Promise<void> {
        const record: OidcConsentRecord = {
            agent_id: params.agentId,
            agent_uid: params.agentUid,
            audience: params.audience.audience,
            provider: params.audience.provider,
            granted_by: params.grantedBy,
            granted_at: new Date().toISOString(),
        };
        await this.kv.put(
            await consentKey(params.agentUid, record.audience),
            JSON.stringify(record)
        );
    }

    async revoke(agentUid: string, audience: string): Promise<void> {
        await this.kv.delete(await consentKey(agentUid, audience));
    }

    private async listKeys(agentUid: string): Promise<string[]> {
        const prefix = `${PREFIX}${agentUid}:`;
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.kv.list({
                prefix,
                ...(cursor ? { cursor } : {}),
            });
            keys.push(...page.keys.map((key) => key.name));
            cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return keys;
    }

    async listForAgent(agentUid: string): Promise<OidcConsentRecord[]> {
        const records: OidcConsentRecord[] = [];
        for (const key of await this.listKeys(agentUid)) {
            const parsed = recordSchema.safeParse(
                await this.kv.get(key, "json")
            );
            if (parsed.success && parsed.data.agent_uid === agentUid) {
                records.push(parsed.data);
            }
        }
        return records;
    }

    async revokeAll(agentUid: string): Promise<void> {
        for (const key of await this.listKeys(agentUid)) {
            await this.kv.delete(key);
        }
    }
}
