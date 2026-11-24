/**
 * @fileoverview
 * RS256 JWT signer backed by the `OIDC_SIGNING_KEY` secret (RSA private key,
 * any format accepted by `pemToPkcs8Der`).
 */

import { base64UrlEncode } from "@/crypto";
import { pemToPkcs8Der } from "@/github/pem-utils";
import {
    MIN_RSA_MODULUS_BITS,
    type PublishedJwk,
    RS256_ALGORITHM,
    modulusBits,
    toPublishedJwk,
} from "@/oidc/jwk";

export type JwtClaims = Record<string, string | number>;

export type OidcSigner = {
    kid: string;
    publicJwk: PublishedJwk;
    signJwt: (claims: JwtClaims) => Promise<string>;
};

const encoder = new TextEncoder();

function encodeSegment(value: object): string {
    return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

/**
 * Derive the public JWK from the private key. The extractable copy is only
 * used here; signing uses a separate non-extractable import.
 */
async function derivePublicJwk(pkcs8: Uint8Array<ArrayBuffer>) {
    const extractable = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        RS256_ALGORITHM,
        true,
        ["sign"]
    );
    const { n, e } = await crypto.subtle.exportKey("jwk", extractable);
    if (!n || !e) throw new Error("OIDC_SIGNING_KEY is not an RSA key");
    return toPublishedJwk({ kty: "RSA", n, e });
}

async function createSigner(rawKey: string): Promise<OidcSigner> {
    let pkcs8: Uint8Array<ArrayBuffer>;
    let publicJwk: PublishedJwk;
    try {
        pkcs8 = pemToPkcs8Der(rawKey);
        publicJwk = await derivePublicJwk(pkcs8);
    } catch {
        // Never echo key material.
        throw new Error(
            "OIDC_SIGNING_KEY must be an RSA private key (PKCS#8 or PKCS#1 PEM)"
        );
    }
    if (modulusBits(publicJwk.n) < MIN_RSA_MODULUS_BITS) {
        throw new Error(
            `OIDC_SIGNING_KEY must be at least ${MIN_RSA_MODULUS_BITS} bits`
        );
    }
    const key = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        RS256_ALGORITHM,
        false,
        ["sign"]
    );
    const header = encodeSegment({
        alg: "RS256",
        typ: "JWT",
        kid: publicJwk.kid,
    });

    return {
        kid: publicJwk.kid,
        publicJwk,
        async signJwt(claims) {
            const signingInput = `${header}.${encodeSegment(claims)}`;
            const signature = await crypto.subtle.sign(
                RS256_ALGORITHM,
                key,
                encoder.encode(signingInput)
            );
            return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
        },
    };
}

// Cached per isolate, keyed by the raw secret so tests (and a rotated secret
// on a warm isolate) never see a stale key.
let cached: { raw: string; signer: Promise<OidcSigner> } | null = null;

export function getOidcSigner(rawKey: string): Promise<OidcSigner> {
    if (cached?.raw === rawKey) return cached.signer;
    const signer = createSigner(rawKey);
    cached = { raw: rawKey, signer };
    // Do not keep a rejected promise around: the next request retries.
    signer.catch(() => {
        if (cached?.signer === signer) cached = null;
    });
    return signer;
}

/** Only needed for testing. */
export function resetOidcSignerCache(): void {
    cached = null;
}
