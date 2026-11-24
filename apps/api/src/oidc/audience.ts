/**
 * @fileoverview
 * Audience (`aud`) validation for OIDC identity tokens, one matcher per
 * relying party. Only audiences a matcher accepts can be requested, so an
 * agent cannot mint tokens for arbitrary relying parties.
 *
 * TODO: Microsoft Entra (`api://AzureADTokenExchange`), Anthropic and OpenAI
 * workload identity federation audiences.
 */

export type GcpAudience = {
    provider: "gcp";
    /** Canonical `https://iam.googleapis.com/...` form — the value signed as `aud`. */
    audience: string;
    projectNumber: string;
    poolId: string;
    providerId: string;
};

export type ParsedAudience = GcpAudience;

// Google signs nothing here; it checks that `aud` equals the provider's
// resource URI prefixed with `https:` (its default allowed audience). The
// `//iam.googleapis.com/...` spelling used by STS and credential
// configuration files is accepted and canonicalized to the `https:` form so
// both spellings share one consent record.
const GCP_AUDIENCE =
    /^(?:https:)?\/\/iam\.googleapis\.com\/projects\/([1-9]\d{0,19})\/locations\/global\/workloadIdentityPools\/([a-z0-9-]{4,32})\/providers\/([a-z0-9-]{4,32})$/;

function parseGcpAudience(raw: string): GcpAudience | null {
    const match = GCP_AUDIENCE.exec(raw);
    if (!match) return null;
    const [, projectNumber, poolId, providerId] = match;
    if (!projectNumber || !poolId || !providerId) return null;
    return {
        provider: "gcp",
        audience: `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
        projectNumber,
        poolId,
        providerId,
    };
}

const MATCHERS: Array<(raw: string) => ParsedAudience | null> = [
    parseGcpAudience,
];

/** Parse and canonicalize a requested audience, or null if no relying party accepts it. */
export function parseAudience(raw: string): ParsedAudience | null {
    for (const match of MATCHERS) {
        const parsed = match(raw);
        if (parsed) return parsed;
    }
    return null;
}
