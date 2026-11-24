/**
 * @fileoverview
 * JWK helpers for the OIDC issuer: RSA public key schema, RFC 7638 thumbprints
 * and strict parsing of the additional (rotation) public key set.
 */

import * as z from "zod";
import { base64UrlEncode } from "@/crypto";

/** Smallest RSA modulus accepted for signing or publishing. */
export const MIN_RSA_MODULUS_BITS = 2048;

export const RS256_ALGORITHM = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
} as const;

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/**
 * RSA public key. Any private member makes the key invalid so private key
 * material can never be published through the JWKS.
 */
export const publicJwkSchema = z.object({
    kty: z.literal("RSA"),
    n: base64Url,
    e: base64Url,
    d: z.never().optional(),
    p: z.never().optional(),
    q: z.never().optional(),
    dp: z.never().optional(),
    dq: z.never().optional(),
    qi: z.never().optional(),
    oth: z.never().optional(),
});
export type PublicJwk = { kty: "RSA"; n: string; e: string };

/** A public JWK as published in the JWKS document. */
export type PublishedJwk = PublicJwk & {
    use: "sig";
    alg: "RS256";
    kid: string;
};

const additionalJwksSchema = z.object({ keys: z.array(publicJwkSchema) });

function base64UrlDecode(value: string): Uint8Array {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Bit length of the base64url-encoded modulus, ignoring leading zero bits. */
export function modulusBits(n: string): number {
    const bytes = base64UrlDecode(n);
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    if (start === bytes.length) return 0;
    return (bytes.length - start - 1) * 8 + (32 - Math.clz32(bytes[start]!));
}

export function toPublicJwk(jwk: PublicJwk): PublicJwk {
    return { kty: "RSA", n: jwk.n, e: jwk.e };
}

/** RFC 7638 thumbprint: SHA-256 over the required members in lexicographic order, no whitespace. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
    const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical)
    );
    return base64UrlEncode(new Uint8Array(digest));
}

export async function toPublishedJwk(jwk: PublicJwk): Promise<PublishedJwk> {
    return {
        ...toPublicJwk(jwk),
        use: "sig",
        alg: "RS256",
        kid: await jwkThumbprint(jwk),
    };
}

function parseJson(raw: string, label: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(`${label} is not valid JSON`);
    }
}

/**
 * Round-trip a public key through WebCrypto so `n` and `e` use the minimal
 * encoding. The signer's `kid` is computed over WebCrypto's export, so a
 * zero-padded `n` (or `e` = "AAEAAQ") from an operator would otherwise get a
 * different thumbprint and break `kid` lookup for tokens the key signed.
 */
async function canonicalizePublicJwk(key: PublicJwk): Promise<PublicJwk> {
    let exported: JsonWebKey;
    try {
        const imported = await crypto.subtle.importKey(
            "jwk",
            key,
            RS256_ALGORITHM,
            true,
            ["verify"]
        );
        exported = await crypto.subtle.exportKey("jwk", imported);
    } catch {
        throw new Error(
            "OIDC_ADDITIONAL_JWKS contains a key that is not a valid RSA public key"
        );
    }
    if (!exported.n || !exported.e) {
        throw new Error(
            "OIDC_ADDITIONAL_JWKS contains a key that is not a valid RSA public key"
        );
    }
    return { kty: "RSA", n: exported.n, e: exported.e };
}

/**
 * Parse the optional `OIDC_ADDITIONAL_JWKS` var (`{"keys":[…]}`, public keys only).
 * Every key must be an importable RSA key of at least 2048 bits; keys are
 * returned in canonical (minimal) encoding.
 */
export async function parseAdditionalJwks(raw: string): Promise<PublicJwk[]> {
    const result = additionalJwksSchema.safeParse(
        parseJson(raw, "OIDC_ADDITIONAL_JWKS")
    );
    if (!result.success) {
        throw new Error(
            "OIDC_ADDITIONAL_JWKS must be a JWKS of RSA public keys (no private members)"
        );
    }
    const keys: PublicJwk[] = [];
    for (const key of result.data.keys) {
        const canonical = await canonicalizePublicJwk(toPublicJwk(key));
        if (modulusBits(canonical.n) < MIN_RSA_MODULUS_BITS) {
            throw new Error(
                `OIDC_ADDITIONAL_JWKS contains an RSA key shorter than ${MIN_RSA_MODULUS_BITS} bits`
            );
        }
        keys.push(canonical);
    }
    return keys;
}
