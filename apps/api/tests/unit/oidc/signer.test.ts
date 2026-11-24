import { assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { getOidcSigner, resetOidcSignerCache } from "@/oidc/signer";
import { RS256_ALGORITHM, jwkThumbprint } from "@/oidc/jwk";
import { generateTestKeyPair } from "@tests/helpers";

const headerSchema = z.strictObject({
    alg: z.literal("RS256"),
    typ: z.literal("JWT"),
    kid: z.string(),
});

function decodeSegment(segment: string): unknown {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
}

function decodeSignature(segment: string): Uint8Array<ArrayBuffer> {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(
        atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)),
        (c) => c.charCodeAt(0)
    );
}

let pkcs8Pem: string;

beforeAll(async () => {
    ({ pkcs8Pem } = await generateTestKeyPair());
});

beforeEach(() => {
    resetOidcSignerCache();
});

describe("getOidcSigner", () => {
    it("signs a JWT that verifies against the published public key", async () => {
        const signer = await getOidcSigner(pkcs8Pem);
        const claims = { sub: "agent:abc", aud: "aud", iat: 1, exp: 601 };
        const jwt = await signer.signJwt(claims);

        const [header, payload, signature] = jwt.split(".");
        assert(header && payload && signature);
        expect(headerSchema.parse(decodeSegment(header))).toEqual({
            alg: "RS256",
            typ: "JWT",
            kid: signer.kid,
        });
        expect(decodeSegment(payload)).toEqual(claims);

        // Verify with only what a relying party sees: the published JWK.
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: signer.publicJwk.n, e: signer.publicJwk.e },
            RS256_ALGORITHM,
            false,
            ["verify"]
        );
        expect(
            await crypto.subtle.verify(
                RS256_ALGORITHM,
                publicKey,
                decodeSignature(signature),
                new TextEncoder().encode(`${header}.${payload}`)
            )
        ).toBe(true);
    });

    it("uses the RFC 7638 thumbprint of the public key as kid", async () => {
        const signer = await getOidcSigner(pkcs8Pem);
        expect(signer.kid).toBe(await jwkThumbprint(signer.publicJwk));
        expect(signer.publicJwk.kid).toBe(signer.kid);
    });

    it("publishes no private key members", async () => {
        const signer = await getOidcSigner(pkcs8Pem);
        expect(Object.keys(signer.publicJwk).sort()).toEqual(
            ["alg", "e", "kid", "kty", "n", "use"].sort()
        );
    });

    it("reuses the signer for the same secret and rebuilds on rotation", async () => {
        const first = await getOidcSigner(pkcs8Pem);
        expect(await getOidcSigner(pkcs8Pem)).toBe(first);

        const { pkcs8Pem: rotated } = await generateTestKeyPair();
        const second = await getOidcSigner(rotated);
        expect(second.kid).not.toBe(first.kid);
    });

    it("rejects a malformed key without echoing it", async () => {
        const error = await getOidcSigner("not-a-key-SECRET").catch(
            (e: unknown) => e
        );
        assert(error instanceof Error);
        expect(error.message).toMatch(/OIDC_SIGNING_KEY must be an RSA/);
        expect(error.message).not.toContain("SECRET");
    });

    it("does not cache a rejected signer", async () => {
        const first = getOidcSigner("bad");
        await expect(first).rejects.toThrow(/OIDC_SIGNING_KEY must be an RSA/);
        // The same (still bad) value must start a fresh attempt instead of
        // returning the cached rejected promise.
        const second = getOidcSigner("bad");
        expect(second).not.toBe(first);
        await expect(second).rejects.toThrow(/OIDC_SIGNING_KEY must be an RSA/);
    });

    it("rejects RSA keys shorter than 2048 bits", async () => {
        const keyPair = await crypto.subtle.generateKey(
            {
                name: "RSASSA-PKCS1-v1_5",
                modulusLength: 1024,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["sign", "verify"]
        );
        const der = new Uint8Array(
            await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)
        );
        const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
        await expect(getOidcSigner(pem)).rejects.toThrow(/at least 2048 bits/);
    });
});
