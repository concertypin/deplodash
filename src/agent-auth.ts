// Agent authentication middleware — long-lived bearer tokens from Deno KV.
//
// Tokens are pre-provisioned strings stored in Deno KV under key `["agent_tokens", <token>]`.
// This is NOT JWT — just a lookup. Simple, revocable, no expiry.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

export interface AgentToken {
  agent_id: string;
  label: string;
  created_at: Date;
}

/** KV key schema for agent tokens. */
const KV_PREFIX = ["agent_tokens"];

/** Verify a bearer token against Deno KV. */
export async function verifyAgentToken(
  kv: Deno.Kv,
  token: string,
): Promise<AgentToken | null> {
  const entry = await kv.get<AgentToken>([...KV_PREFIX, token]);
  return entry.value;
}

/** Register a new agent token in Deno KV (admin use). */
export async function registerAgentToken(
  kv: Deno.Kv,
  token: string,
  agentId: string,
  label?: string,
): Promise<void> {
  const value: AgentToken = {
    agent_id: agentId,
    label: label ?? agentId,
    created_at: new Date(),
  };
  await kv.set([...KV_PREFIX, token], value);
}

/** Revoke an agent token. */
export async function revokeAgentToken(
  kv: Deno.Kv,
  token: string,
): Promise<void> {
  await kv.delete([...KV_PREFIX, token]);
}

/** List all registered agent tokens. */
export async function listAgentTokens(kv: Deno.Kv): Promise<Array<{ token: string; info: AgentToken }>> {
  const entries = kv.list<AgentToken>({ prefix: KV_PREFIX });
  const result: Array<{ token: string; info: AgentToken }> = [];
  for await (const entry of entries) {
    result.push({ token: entry.key[entry.key.length - 1] as string, info: entry.value });
  }
  return result;
}

// ─── Hono middleware ──────────────────────────────────────────────────────────

/** Extract agent token from Authorization header. */
function extractBearerToken(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Middleware that verifies the agent bearer token.
 *
 * Places the validated `AgentToken` in `c.set("agent", token)` on success.
 * Returns 401 on missing / invalid token.
 */
export function agentAuthMiddleware(kv: Deno.Kv): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearerToken(c);
    if (!token) {
      return c.json({ error: "missing_authorization", message: "Bearer token required" }, 401);
    }
    const agent = await verifyAgentToken(kv, token);
    if (!agent) {
      return c.json({ error: "invalid_token", message: "Agent token not found" }, 401);
    }
    c.set("agent", agent);
    await next();
  };
}
