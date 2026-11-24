/**
 * Display helpers for OIDC (Workload Identity Federation) audiences.
 *
 * Display only: the API validates and canonicalizes every audience, so this
 * only needs to split the canonical `https://iam.googleapis.com/...` form
 * into readable parts.
 */

export type GcpAudienceParts = {
    projectNumber: string;
    poolId: string;
    providerId: string;
};

const GCP_AUDIENCE =
    /^https:\/\/iam\.googleapis\.com\/projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]+)\/providers\/([a-z0-9-]+)$/;

export function describeGcpAudience(audience: string): GcpAudienceParts | null {
    const match = GCP_AUDIENCE.exec(audience);
    if (!match) return null;
    const [, projectNumber, poolId, providerId] = match;
    if (!projectNumber || !poolId || !providerId) return null;
    return { projectNumber, poolId, providerId };
}

export type OidcConsentRequest = {
    agentUid: string;
    audience: string;
    gcp: GcpAudienceParts;
};

/**
 * Read an OIDC consent link (`/auth/oidc-consent?agent_uid=&audience=`).
 *
 * The link's `agent_id` is deliberately ignored: anyone can craft a link,
 * and several users may own agents with the same `agent_id`. The agent is
 * identified only by its uid and named from the server (`findAgentBySubject`).
 */
export function parseOidcConsentParams(
    search: string
): OidcConsentRequest | null {
    const params = new URLSearchParams(search);
    const agentUid = params.get("agent_uid");
    const audience = params.get("audience");
    const gcp = audience ? describeGcpAudience(audience) : null;
    if (!agentUid || !audience || !gcp) return null;
    return { agentUid, audience, gcp };
}

/** Find the signed-in user's agent whose OIDC subject is `agent:<uid>`. */
export function findAgentBySubject<
    T extends { oidc_subject?: string | undefined },
>(agents: readonly T[], agentUid: string): T | null {
    const subject = `agent:${agentUid}`;
    return agents.find((agent) => agent.oidc_subject === subject) ?? null;
}
