/**
 * Agent authentication middleware — Bearer token verification against Cloudflare KV.
 *
 * Agent tokens are pre-provisioned strings stored in KV under:
 *   agent_tokens:${token} → { agent_id, label, created_at }
 *
 * This is NOT JWT — just a KV lookup. Simple, revocable, no expiry.
 */

import type { MiddlewareHandler } from "hono";
import type { HonoEnv, AgentInfo } from "@/types";
import { z } from "zod";

/** KV key prefix for agent tokens. */
const AGENT_PREFIX = "agent_tokens:";

/**
 * Runtime schema for AgentInfo stored in KV.
 */
const agentInfoSchema = z.object({
    agent_id: z.string(),
    label: z.string(),
    created_at: z.string(),
    created_by: z.string().optional(),
});

/** Convert a Zod-parsed token value to AgentInfo. */
function toAgentInfo(
    data: z.infer<typeof agentInfoSchema>,
): AgentInfo {
    return {
        agent_id: data.agent_id,
        label: data.label,
        created_at: data.created_at,
        ...(data.created_by ? { created_by: data.created_by } : {}),
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
    createdBy?: string
): Promise<void> {
    const key = `${AGENT_PREFIX}${token}`;
    const info: AgentInfo = {
        agent_id: agentId,
        label: label ?? agentId,
        created_at: new Date().toISOString(),
        ...(createdBy ? { created_by: createdBy } : {}),
    };
    await kv.put(key, JSON.stringify(info));
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
        await next();
    };
}
