/**
 * @fileoverview
 * OIDC issuer configuration: issuer URL validation, discovery document and JWKS.
 */

import type { Env } from "@/types";
import {
    type PublishedJwk,
    parseAdditionalJwks,
    toPublishedJwk,
} from "@/oidc/jwk";
import { getOidcSigner } from "@/oidc/signer";

export const OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";
export const JWKS_PATH = "/.well-known/jwks.json";

/** Claims carried by Deplodash identity tokens. */
export const SUPPORTED_CLAIMS = [
    "iss",
    "sub",
    "aud",
    "iat",
    "nbf",
    "exp",
    "jti",
    "agent_id",
    "owner_github_id",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Returns the canonical issuer (`scheme://host`) or null when the value is
 * not acceptable. Relying parties require https on the default port (AWS
 * rejects issuers with a port, Anthropic requires 443); plain http and ports
 * are allowed for local dev hosts only. Paths, queries, fragments, trailing
 * slashes, credentials, non-canonical spellings (`origin !== raw`), a
 * trailing-dot FQDN and public IP literals are rejected so the issuer can
 * never drift from the `iss` claim or from the name relying parties fetch.
 */
export function normalizeIssuer(raw: string | undefined): string | null {
    if (!raw || !URL.canParse(raw)) return null;
    const url = new URL(raw);
    if (url.origin !== raw) return null;
    const isLocal = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
        return null;
    }
    if (isLocal) return url.origin;
    if (url.port) return null;
    if (url.hostname.endsWith(".")) return null;
    const isIpLiteral =
        url.hostname.startsWith("[") || /^[\d.]+$/.test(url.hostname);
    if (isIpLiteral) return null;
    return url.origin;
}

export type IssuerConfig = {
    issuer: string;
    jwksUri: string;
    signingKey: string;
};

/**
 * The OIDC feature is enabled only when both a valid `OIDC_ISSUER` and an
 * `OIDC_SIGNING_KEY` are configured. A half or invalid configuration is
 * logged so a typo (e.g. a trailing slash) does not silently disable it.
 */
export function getIssuerConfig(
    env: Pick<Env, "OIDC_ISSUER" | "OIDC_SIGNING_KEY">
): IssuerConfig | null {
    if (!env.OIDC_ISSUER && !env.OIDC_SIGNING_KEY) return null;
    const issuer = normalizeIssuer(env.OIDC_ISSUER);
    if (!issuer || !env.OIDC_SIGNING_KEY) {
        console.warn(
            !env.OIDC_ISSUER || !env.OIDC_SIGNING_KEY
                ? "oidc: disabled — OIDC_ISSUER and OIDC_SIGNING_KEY must both be set"
                : "oidc: disabled — OIDC_ISSUER is not a canonical https origin (no port, path or trailing slash)"
        );
        return null;
    }
    return {
        issuer,
        jwksUri: `${issuer}${JWKS_PATH}`,
        signingKey: env.OIDC_SIGNING_KEY,
    };
}

export function buildDiscoveryDocument(config: IssuerConfig) {
    return {
        issuer: config.issuer,
        jwks_uri: config.jwksUri,
        // Token-only issuer (like GitHub Actions'): no authorization or
        // token endpoint is advertised because none exists.
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        scopes_supported: ["openid"],
        id_token_signing_alg_values_supported: ["RS256"],
        claims_supported: [...SUPPORTED_CLAIMS],
    };
}

/** Active public key first, then the additional (rotation) keys; duplicate `kid`s are dropped. */
export async function buildJwks(
    config: IssuerConfig,
    additionalJwks: string | undefined
): Promise<{ keys: PublishedJwk[] }> {
    const active = (await getOidcSigner(config.signingKey)).publicJwk;
    const additional = additionalJwks
        ? await Promise.all(
              (await parseAdditionalJwks(additionalJwks)).map(toPublishedJwk)
          )
        : [];

    const keys = new Map<string, PublishedJwk>();
    for (const key of [active, ...additional]) {
        if (!keys.has(key.kid)) keys.set(key.kid, key);
    }
    return { keys: [...keys.values()] };
}
