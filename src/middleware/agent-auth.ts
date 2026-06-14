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

/** KV key prefix for agent tokens. */
const AGENT_PREFIX = "agent_tokens:";

/**
 * Verify a bearer token against Cloudflare KV.
 * Returns the agent info or null if invalid.
 */
export async function verifyAgentToken(
    kv: KVNamespace,
    token: string
): Promise<AgentInfo | null> {
    const key = `${AGENT_PREFIX}${token}`;
    const value = await kv.get(key, "json");
    return value as AgentInfo | null;
}

/**
 * Register a new agent token in KV (admin use).
 */
export async function registerAgentToken(
    kv: KVNamespace,
    token: string,
    agentId: string,
    label?: string
): Promise<void> {
    const key = `${AGENT_PREFIX}${token}`;
    const info: AgentInfo = {
        agent_id: agentId,
        label: label ?? agentId,
        created_at: new Date().toISOString(),
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
 * Note: KV list is eventually consistent and may be expensive for large datasets.
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
            result.push({ token, info: value as AgentInfo });
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
