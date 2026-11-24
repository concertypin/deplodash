/**
 * Consent routes — API endpoints for granting and revoking agent token consent.
 *
 * POST /api/consent          — grant consent for an agent
 * POST /api/consent/revoke   — revoke consent for an agent
 * POST /api/consent/oidc        — let an agent mint OIDC tokens for an audience
 * POST /api/consent/oidc/revoke — withdraw that permission
 *
 * Both endpoints require a valid session cookie and return JSON.
 */

import { type Context, Hono } from "hono";
import { validator } from "hono-openapi";
import * as z from "zod";
import type { AgentInfo, GitHubUser, HonoEnv } from "@/types";
import type { ParsedAudience } from "@/oidc/audience";
import type { GitHubClient } from "@/github";
import { authGuard } from "@/middleware";
import { TokenService } from "@/token/service";
import { ConsentOwnershipError } from "@/errors";
import { notifyWaiters } from "@/token/wait-notifier";
import { APPROVABLE_SCOPES, expandCompoundScopes } from "@/github/scopes";
import { isRateLimited } from "@/rate-limit";
import {
    findAgentByUid,
    isAgentOwner,
    setAgentOwnerId,
} from "@/middleware/agent-auth";
import { parseAudience } from "@/oidc/audience";
import { OidcConsentService, oidcWaiterKey } from "@/oidc/consent";

// ─── Schema ──────────────────────────────────────────────────────────────────

const consentSchema = z.object({
    repo: z
        .string()
        .regex(
            /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9-._]+$/,
            "Invalid repository format"
        ),
    agent_id: z.string().min(1),
    scopes: z.union([z.string(), z.array(z.string())]).optional(),
    repo_mode: z
        .enum(["existing-only", "create-if-missing"])
        .default("existing-only"),
});

const revokeSchema = z.object({
    repo: z.string().min(1),
    scopes: z.string().min(1),
    agent_id: z.string().min(1).optional(),
});

const oidcConsentSchema = z.object({
    agent_uid: z.string().regex(/^[A-Za-z0-9_-]{22}$/, "Invalid agent uid"),
    audience: z.string().min(1).max(512),
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at /api/consent — relative paths

async function assertApproverCanGrantConsent(
    ghClient: GitHubClient,
    username: string,
    repo: string
): Promise<void> {
    const parts = repo.split("/");
    const owner = parts[0];
    const name = parts[1];
    if (!owner || !name) throw new Error("Invalid repository format");

    // 1. If user is an admin on the existing repo, they are authorized.
    if (await ghClient.checkRepoAdmin(owner, name)) return;

    // 2. If repo doesn't exist, user must own the target namespace or be an org owner.
    if (owner.toLowerCase() === username.toLowerCase()) return;
    if (await ghClient.checkOrgAdmin(owner, username)) return;

    throw new Error(
        `User ${username} lacks administrative authority for repository ${repo}`
    );
}

export const consentRouter = new Hono<HonoEnv>()
    .post("/", authGuard(), validator("json", consentSchema), async (c) => {
        const {
            repo,
            agent_id,
            scopes: rawScopes,
            repo_mode,
        } = c.req.valid("json");
        const origin = c.req.header("Origin");
        if (origin && origin !== new URL(c.req.url).origin) {
            return c.json({ error: "CSRF detected" }, 403);
        }

        if (
            await isRateLimited(
                c.env.TOKEN_RATE_LIMITER,
                c.req.header("CF-Connecting-IP") || "unknown"
            )
        ) {
            return c.json({ error: "Rate limited. Try again later." }, 429);
        }

        try {
            if (!rawScopes) {
                return c.json(
                    {
                        error: "You must select at least one permission to proceed.",
                    },
                    400
                );
            }
            const scopeList = [
                ...new Set(
                    Array.isArray(rawScopes)
                        ? rawScopes.map((scope) => scope.trim()).filter(Boolean)
                        : rawScopes
                              .split(",")
                              .map((scope) => scope.trim())
                              .filter(Boolean)
                ),
            ];
            if (scopeList.length === 0) {
                return c.json(
                    {
                        error: "You must select at least one permission to proceed.",
                    },
                    400
                );
            }
            const expandedList = expandCompoundScopes(scopeList);
            const unsupportedScopes = expandedList.filter(
                (scope) => !APPROVABLE_SCOPES.has(scope)
            );
            if (unsupportedScopes.length > 0) {
                return c.json(
                    {
                        error: `Cannot approve unsupported scopes: ${unsupportedScopes.join(", ")}`,
                    },
                    400
                );
            }

            const ghClient = c.get("client")!;
            let grantedBy: string;
            try {
                grantedBy = (await ghClient.getUser()).login;
            } catch {
                return c.json(
                    { error: "Failed to verify identity. Please try again." },
                    401
                );
            }
            try {
                await assertApproverCanGrantConsent(ghClient, grantedBy, repo);
            } catch (err: unknown) {
                return c.json(
                    {
                        error:
                            err instanceof Error
                                ? err.message
                                : "Lacks administrative authority for repository",
                    },
                    403
                );
            }

            const tokenService = new TokenService(c.env.KV);
            if (repo_mode === "create-if-missing") {
                const [owner, name] = repo.split("/");
                if (
                    owner &&
                    name &&
                    !(await ghClient.repoExists(owner, name))
                ) {
                    try {
                        await ghClient.createRepository(
                            owner,
                            name,
                            true,
                            grantedBy
                        );
                    } catch (error: unknown) {
                        if (
                            !(
                                error instanceof Error &&
                                error.message.startsWith("GitHub 422")
                            ) ||
                            !(await ghClient.repoExists(owner, name))
                        ) {
                            throw error;
                        }
                    }
                }
            }
            for (const scope of expandedList) {
                await tokenService.recordConsent(
                    agent_id,
                    repo,
                    [scope],
                    expandedList,
                    grantedBy,
                    repo_mode
                );
            }
            notifyWaiters(repo, agent_id);
            return c.json({ status: "ok" });
        } catch (err: unknown) {
            console.error("consent: failed to grant consent", err);
            return c.json(
                {
                    error:
                        err instanceof Error
                            ? err.message
                            : "Failed to grant consent",
                },
                500
            );
        }
    })
    .post(
        "/revoke",
        authGuard(),
        validator("json", revokeSchema),
        async (c) => {
            const { repo, scopes, agent_id } = c.req.valid("json");
            // CSRF protection — validate Origin header
            const origin = c.req.header("Origin");
            if (origin && origin !== new URL(c.req.url).origin) {
                return c.json({ error: "CSRF detected" }, 403);
            }
            // Rate limiting — per-IP throttle for consent endpoints
            if (
                await isRateLimited(
                    c.env.TOKEN_RATE_LIMITER,
                    c.req.header("CF-Connecting-IP") || "unknown"
                )
            ) {
                return c.json({ error: "Rate limited. Try again later." }, 429);
            }
            const client = c.get("client")!;
            const tokenService = new TokenService(c.env.KV);
            try {
                const scopeList = scopes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                // Resolve the current user's GitHub login for ownership check
                let caller: string;
                try {
                    const user = await client.getUser();
                    caller = user.login;
                } catch {
                    return c.json(
                        {
                            error: "Failed to verify identity. Please try again.",
                        },
                        401
                    );
                }
                await tokenService.revokeConsent(
                    agent_id ?? "",
                    repo,
                    scopeList,
                    caller
                );
                console.log(
                    `REVOKE: repo=${repo} scopeList=${JSON.stringify(
                        scopeList
                    )} scopes=${scopes}`
                );
                return c.json({ status: "ok" });
            } catch (err: unknown) {
                console.error("consent: failed to revoke consent", err);
                if (err instanceof ConsentOwnershipError) {
                    return c.json(
                        { error: "Cannot revoke another user's consent" },
                        403
                    );
                }
                return c.json({ error: "Failed to revoke consent" }, 500);
            }
        }
    )
    .post(
        "/oidc",
        authGuard(),
        validator("json", oidcConsentSchema),
        async (c) => {
            const guard = await guardOidcConsentRequest(c);
            if (guard instanceof Response) return guard;
            const { agent, audience, user } = guard;

            const agentUid = agent.info.uid!;
            try {
                await setAgentOwnerId(c.env.KV, agent.token, user.id);
                await new OidcConsentService(c.env.KV).grant({
                    agentId: agent.info.agent_id,
                    agentUid,
                    audience,
                    grantedBy: user.login,
                });
            } catch (err: unknown) {
                console.error("consent: failed to grant OIDC consent", err);
                return c.json({ error: "Failed to grant consent" }, 500);
            }
            notifyWaiters(oidcWaiterKey(audience.audience), agentUid);
            return c.json({ status: "ok" });
        }
    )
    .post(
        "/oidc/revoke",
        authGuard(),
        validator("json", oidcConsentSchema),
        async (c) => {
            const guard = await guardOidcConsentRequest(c);
            if (guard instanceof Response) return guard;
            try {
                await new OidcConsentService(c.env.KV).revoke(
                    guard.agent.info.uid!,
                    guard.audience.audience
                );
            } catch (err: unknown) {
                console.error("consent: failed to revoke OIDC consent", err);
                return c.json({ error: "Failed to revoke consent" }, 500);
            }
            return c.json({ status: "ok" });
        }
    );

/**
 * Shared checks for OIDC consent changes: same-origin, rate limit, a
 * supported audience, and — the security boundary — that the signed-in user
 * owns the agent. Only the owner can let their agent assume cloud
 * identities; Deplodash cannot verify who administers the relying party.
 */
async function guardOidcConsentRequest(
    c: Context<
        HonoEnv,
        string,
        { out: { json: z.infer<typeof oidcConsentSchema> } }
    >
): Promise<
    | Response
    | {
          agent: { token: string; info: AgentInfo };
          audience: ParsedAudience;
          user: GitHubUser;
      }
> {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) {
        return c.json({ error: "CSRF detected" }, 403);
    }
    if (
        await isRateLimited(
            c.env.TOKEN_RATE_LIMITER,
            c.req.header("CF-Connecting-IP") || "unknown"
        )
    ) {
        return c.json({ error: "Rate limited. Try again later." }, 429);
    }
    const { agent_uid, audience: rawAudience } = c.req.valid("json");
    const audience = parseAudience(rawAudience);
    if (!audience) return c.json({ error: "Unsupported audience" }, 400);

    let user: GitHubUser;
    try {
        user = await c.get("client")!.getUser();
    } catch {
        return c.json(
            { error: "Failed to verify identity. Please try again." },
            401
        );
    }
    const agent = await findAgentByUid(c.env.KV, agent_uid);
    // Same response for "no such agent" and "not yours" so uids of other
    // users' agents cannot be probed.
    if (!agent || !isAgentOwner(agent.info, user)) {
        return c.json(
            { error: "Only the agent's owner can change its OIDC access" },
            403
        );
    }
    return { agent, audience, user };
}
