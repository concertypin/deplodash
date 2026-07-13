/**
 * Token cache — GitHub Installation Token caching via Cloudflare KV.
 *
 * KV key layout:
 *   gh_token:${agentId}:${repo}:${scopesHash}    → CachedToken
 *
 * Cache entries expire 5 minutes before the actual token expiry,
 * with a maximum TTL of 1 hour.
 */

import { hashScopes } from "@/github/scopes";
import type { CachedToken } from "@/types";
import * as z from "zod";

const dropBufferTime = 5 * 60 * 1000;

const kvSchema = z.object({
    token: z.string(),
    expires_at: z.string(),
});

function tokenCacheKey(
    agentId: string,
    repo: string,
    scopesHash: string
): string {
    return `gh_token:${agentId}:${repo}:${scopesHash}`;
}

/**
 * Retrieve a cached token, or null if not cached / expired.
 */
export async function getCachedToken(
    kv: KVNamespace,
    agentId: string,
    repo: string,
    scopes: string[]
): Promise<CachedToken | null> {
    const hash = await hashScopes(scopes);
    const key = tokenCacheKey(agentId, repo, hash);
    const value = await kv.get(key, "json");
    if (!value) return null;
    const cached = kvSchema.parse(value);
    const expiresAt = new Date(cached.expires_at).getTime();
    if (expiresAt - dropBufferTime < Date.now()) {
        await kv.delete(key);
        return null;
    }
    return cached;
}

/**
 * Cache a GitHub Installation Token.
 * Skips caching if the token is too close to expiry (within 5 min + buffer).
 */
export async function cacheToken(
    kv: KVNamespace,
    agentId: string,
    repo: string,
    scopes: string[],
    token: string,
    expiresAt: string
): Promise<void> {
    const hash = await hashScopes(scopes);
    const key = tokenCacheKey(agentId, repo, hash);
    const cached: CachedToken = { token, expires_at: expiresAt };
    const expiresAtMs = new Date(expiresAt).getTime();
    const safeUntil = expiresAtMs - dropBufferTime;
    if (safeUntil <= Date.now()) {
        return;
    }
    const ttl = Math.floor((safeUntil - Date.now()) / 1000);
    await kv.put(key, JSON.stringify(cached), {
        expirationTtl: Math.min(ttl, 3600),
    });
}
