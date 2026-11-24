/**
 * Agent authentication middleware — Bearer token verification against Cloudflare KV.
 *
 * Agent tokens are pre-provisioned strings stored in KV under:
 *   agent_tokens:${token} → { agent_id, label, created_at, created_by?, created_by_id?, uid? }
 *
 * `uid` is a random, immutable identifier used as the OIDC `sub`. It lives
 * in the token record on purpose: revoking the token deletes the uid with it,
 * so an agent re-created under the same `agent_id` (by anyone, or through the
 * CLI) never inherits a relying party's trust or an OIDC consent.
 *
 * This is NOT JWT — just a KV lookup. Simple, revocable, no expiry.
 */

import type { MiddlewareHandler } from "hono";
import type { HonoEnv, AgentInfo } from "@/types";
import { z } from "zod";
import { randomBytes } from "@/crypto";

/** KV key prefix for agent tokens. */
const AGENT_PREFIX = "agent_tokens:";

/** Reverse index `agent_uid:${uid}` → token, so consent checks avoid a full scan. */
const UID_INDEX_PREFIX = "agent_uid:";

/**
 * Runtime schema for AgentInfo stored in KV.
 */
const agentInfoSchema = z.object({
    agent_id: z.string(),
    label: z.string(),
    created_at: z.string(),
    created_by: z.string().optional(),
    created_by_id: z.number().int().optional(),
    uid: z
        .string()
        .regex(/^[A-Za-z0-9_-]{22}$/)
        .optional(),
});

/** Random 128-bit agent uid, base64url (22 chars). */
export function generateAgentUid(): string {
    return randomBytes(16);
}

/** Convert a Zod-parsed token value to AgentInfo. */
function toAgentInfo(data: z.infer<typeof agentInfoSchema>): AgentInfo {
    return {
        agent_id: data.agent_id,
        label: data.label,
        created_at: data.created_at,
        ...(data.created_by ? { created_by: data.created_by } : {}),
        ...(data.created_by_id !== undefined
            ? { created_by_id: data.created_by_id }
            : {}),
        ...(data.uid ? { uid: data.uid } : {}),
    };
}

/**
 * Verify a bearer token against Cloudflare KV.
 * Returns the agent info or null if invalid / malformed.
 */
export async function verifyAgentToken(
    kv: KVNamespace,
    token: string
): Promise<AgentInfo | null> {
    const key = `${AGENT_PREFIX}${token}`;
    const value = await kv.get(key, "json");
    if (!value) return null;
    const parsed = agentInfoSchema.safeParse(value);
    if (!parsed.success) return null;
    return toAgentInfo(parsed.data);
}

/**
 * Register a new agent token in KV.
 */
export async function registerAgentToken(
    kv: KVNamespace,
    token: string,
    agentId: string,
    label?: string,
    createdBy?: string,
    createdById?: number
): Promise<AgentInfo> {
    const key = `${AGENT_PREFIX}${token}`;
    const info: AgentInfo = {
        agent_id: agentId,
        label: label ?? agentId,
        created_at: new Date().toISOString(),
        ...(createdBy ? { created_by: createdBy } : {}),
        ...(createdById !== undefined ? { created_by_id: createdById } : {}),
        uid: generateAgentUid(),
    };
    await kv.put(key, JSON.stringify(info));
    await kv.put(`${UID_INDEX_PREFIX}${info.uid}`, token);
    return info;
}

/**
 * Rewrite an agent record from its *current* stored value. Re-reading right
 * before the write keeps a background update (uid backfill, owner id) from
 * resurrecting a token revoked meanwhile. KV has no compare-and-swap, so
 * this narrows the window rather than closing it.
 */
async function updateAgentRecord(
    kv: KVNamespace,
    token: string,
    update: (current: AgentInfo) => AgentInfo
): Promise<AgentInfo | null> {
    const current = await verifyAgentToken(kv, token);
    if (!current) return null;
    const next = update(current);
    await kv.put(`${AGENT_PREFIX}${token}`, JSON.stringify(next));
    return next;
}

/**
 * Return the agent's uid, assigning one to records created before uids
 * existed. Two concurrent first calls can each assign a uid; the later write
 * wins and the earlier caller may briefly hand out a uid that no longer
 * exists (its consent URL then fails and a retry heals it). It never grants
 * anything: consent is keyed by uid.
 */
export async function ensureAgentUid(
    kv: KVNamespace,
    token: string,
    info: AgentInfo
): Promise<string> {
    if (info.uid) return info.uid;
    const updated = await updateAgentRecord(kv, token, (current) =>
        current.uid ? current : { ...current, uid: generateAgentUid() }
    );
    if (!updated?.uid) throw new Error("Agent token no longer exists");
    await kv.put(`${UID_INDEX_PREFIX}${updated.uid}`, token);
    return updated.uid;
}

/**
 * Whether `user` owns the agent. The immutable numeric id decides when it
 * is recorded; the renameable login is only trusted for records created
 * before ids were stored (a freed login can be re-registered by someone else).
 */
export function isAgentOwner(
    info: AgentInfo,
    user: { login: string; id: number }
): boolean {
    if (info.created_by_id !== undefined) return info.created_by_id === user.id;
    return info.created_by !== undefined && info.created_by === user.login;
}

/**
 * Record the owner's numeric GitHub id on a record created before it was
 * stored. Never replaces a different id: callers must check ownership with
 * `isAgentOwner` first.
 */
export async function setAgentOwnerId(
    kv: KVNamespace,
    token: string,
    ownerId: number
): Promise<void> {
    await updateAgentRecord(kv, token, (current) =>
        current.created_by_id === undefined
            ? { ...current, created_by_id: ownerId }
            : current
    );
}

/** Find a live agent token record by its uid via the reverse index. */
export async function findAgentByUid(
    kv: KVNamespace,
    uid: string
): Promise<{ token: string; info: AgentInfo } | null> {
    const token = await kv.get(`${UID_INDEX_PREFIX}${uid}`);
    if (!token) return null;
    const info = await verifyAgentToken(kv, token);
    // The index can outlive the token (e.g. revoked through the CLI) or point
    // at a record whose uid was replaced by a racing backfill.
    if (!info || info.uid !== uid) return null;
    return { token, info };
}

/** Delete the reverse index entry for a revoked agent's uid. */
export async function deleteAgentUidIndex(
    kv: KVNamespace,
    uid: string
): Promise<void> {
    await kv.delete(`${UID_INDEX_PREFIX}${uid}`);
}

/**
 * Revoke an agent token.
 */
export async function revokeAgentToken(
    kv: KVNamespace,
    token: string
): Promise<void> {
    const key = `${AGENT_PREFIX}${token}`;
    await kv.delete(key);
}

/**
 * List all registered agent tokens by scanning KV.
 *
 * Note: KV list is eventually consistent and may be expensive for large datasets.
 * TODO: Handle cursor-based pagination — kv.list() returns at most 1000 keys.
 */
export async function listAgentTokens(
    kv: KVNamespace
): Promise<Array<{ token: string; info: AgentInfo }>> {
    const entries = await kv.list({ prefix: AGENT_PREFIX });
    const result: Array<{ token: string; info: AgentInfo }> = [];
    for (const entry of entries.keys) {
        const token = entry.name.slice(AGENT_PREFIX.length);
        const value = await kv.get(entry.name, "json");
        if (value) {
            const parsed = agentInfoSchema.safeParse(value);
            if (parsed.success) {
                result.push({ token, info: toAgentInfo(parsed.data) });
            }
        }
    }
    return result;
}

// ─── Hono middleware ─────────────────────────────────────────────────────────

/**
 * Extract the Bearer token from the Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const parts = authHeader.split(/\s+/);
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
    return parts[1] ?? null;
}

/**
 * Hono middleware that validates the Bearer token from the Authorization header
 * against the agent tokens stored in KV.
 *
 * On success, sets `c.set("agent_id", agentInfo.agent_id)`.
 * On failure, returns 401.
 */
export function agentAuthMiddleware(): MiddlewareHandler<HonoEnv> {
    return async (c, next) => {
        const authHeader = c.req.header("Authorization");
        const token = extractBearerToken(authHeader);
        if (!token) {
            return c.json(
                { error: "Missing or invalid Authorization header" },
                401
            );
        }

        const agentInfo = await verifyAgentToken(c.env.KV, token);
        if (!agentInfo) {
            return c.json({ error: "Invalid agent token" }, 401);
        }

        c.set("agent_id", agentInfo.agent_id);
        c.set("agent", { token, info: agentInfo });
        await next();
    };
}
