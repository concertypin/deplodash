/**
 * @fileoverview
 * Identity token minting. Tokens are minted on demand and never cached:
 * some relying parties (e.g. Anthropic) treat `jti` as single-use.
 */

import { randomBytes } from "@/crypto";
import type { IssuerConfig } from "@/oidc/issuer";
import { type JwtClaims, getOidcSigner } from "@/oidc/signer";

/** Well under every relying party's limit (Anthropic 1 h, GCP 24 h). */
export const ID_TOKEN_LIFETIME_SECONDS = 600;

export const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

/** The OIDC `sub` for an agent; relying parties should pin it exactly. */
export function agentSubject(agentUid: string): string {
    return `agent:${agentUid}`;
}

export async function mintIdToken(
    config: IssuerConfig,
    params: {
        agentUid: string;
        agentId: string;
        ownerGithubId?: number | undefined;
        audience: string;
    },
    nowMs: number = Date.now()
): Promise<{ idToken: string; expiresAt: string }> {
    const signer = await getOidcSigner(config.signingKey);
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + ID_TOKEN_LIFETIME_SECONDS;
    const claims: JwtClaims = {
        iss: config.issuer,
        sub: agentSubject(params.agentUid),
        aud: params.audience,
        iat,
        nbf: iat,
        exp,
        jti: randomBytes(16),
        agent_id: params.agentId,
        ...(params.ownerGithubId !== undefined
            ? { owner_github_id: params.ownerGithubId }
            : {}),
    };
    return {
        idToken: await signer.signJwt(claims),
        expiresAt: new Date(exp * 1000).toISOString(),
    };
}
