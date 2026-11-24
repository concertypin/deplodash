import { assert, beforeAll, describe, expect, it } from "vitest";
import {
    jwkThumbprint,
    modulusBits,
    parseAdditionalJwks,
    toPublishedJwk,
} from "@/oidc/jwk";
import { base64UrlEncode } from "@/crypto";

function base64UrlToBytes(value: string): Uint8Array {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(
        atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)),
        (c) => c.charCodeAt(0)
    );
}

async function generateRsaJwk(modulusLength: number): Promise<JsonWebKey> {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
    );
    return crypto.subtle.exportKey("jwk", keyPair.privateKey);
}

let privateJwk: JsonWebKey;
let publicJwk: { kty: "RSA"; n: string; e: string };

beforeAll(async () => {
    privateJwk = await generateRsaJwk(2048);
    publicJwk = { kty: "RSA", n: privateJwk.n!, e: privateJwk.e! };
});

describe("jwkThumbprint", () => {
    it("matches the RFC 7638 §3.1 example", async () => {
        // Example key and expected thumbprint from RFC 7638 §3.1.
        const n =
            "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
        expect(await jwkThumbprint({ kty: "RSA", n, e: "AQAB" })).toBe(
            "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
        );
    });

    it("ignores members other than e, kty and n", async () => {
        const withExtras = { ...publicJwk, kid: "other", alg: "RS256" };
        expect(await jwkThumbprint(withExtras)).toBe(
            await jwkThumbprint(publicJwk)
        );
    });
});

describe("modulusBits", () => {
    it("reports the RSA modulus length", () => {
        expect(modulusBits(publicJwk.n)).toBe(2048);
    });

    it("ignores leading zero bytes", () => {
        // 0x00 0x01 → 1 bit
        expect(modulusBits("AAE")).toBe(1);
    });
});

describe("toPublishedJwk", () => {
    it("publishes only public members with use, alg and kid", async () => {
        const withPrivate = { ...publicJwk, d: privateJwk.d };
        const published = await toPublishedJwk(withPrivate);
        expect(Object.keys(published).sort()).toEqual(
            ["alg", "e", "kid", "kty", "n", "use"].sort()
        );
        expect(published).toMatchObject({ use: "sig", alg: "RS256" });
        expect(published.kid).toBe(await jwkThumbprint(publicJwk));
    });
});

describe("parseAdditionalJwks", () => {
    it("accepts RSA public keys", async () => {
        const keys = await parseAdditionalJwks(
            JSON.stringify({ keys: [{ ...publicJwk, alg: "RS256" }] })
        );
        expect(keys).toEqual([publicJwk]);
    });

    it.each(["d", "p", "q", "dp", "dq", "qi"] as const)(
        "rejects a key carrying the private member %s",
        async (member) => {
            const leaked = { ...publicJwk, [member]: privateJwk[member] };
            await expect(
                parseAdditionalJwks(JSON.stringify({ keys: [leaked] }))
            ).rejects.toThrow(/no private members/);
        }
    );

    it("canonicalizes a zero-padded n and e so the kid matches the signer's", async () => {
        const modulus = base64UrlToBytes(publicJwk.n);
        const padded = {
            kty: "RSA",
            // A leading 0x00 byte is a valid but non-minimal encoding.
            n: base64UrlEncode(new Uint8Array([0, ...modulus])),
            e: "AAEAAQ",
        };
        expect(padded.n).not.toBe(publicJwk.n);
        const [key] = await parseAdditionalJwks(
            JSON.stringify({ keys: [padded] })
        );
        expect(key).toEqual(publicJwk);
        assert(key);
        expect(await jwkThumbprint(key)).toBe(await jwkThumbprint(publicJwk));
    });

    it("rejects keys shorter than 2048 bits", async () => {
        const short = await generateRsaJwk(1024);
        await expect(
            parseAdditionalJwks(
                JSON.stringify({
                    keys: [{ kty: "RSA", n: short.n, e: short.e }],
                })
            )
        ).rejects.toThrow(/shorter than 2048 bits/);
    });

    it("rejects EC keys", async () => {
        await expect(
            parseAdditionalJwks(
                JSON.stringify({
                    keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b" }],
                })
            )
        ).rejects.toThrow(/RSA public keys/);
    });

    it("rejects invalid JSON without echoing it", async () => {
        const error = await parseAdditionalJwks("{secret-ish").catch(
            (e: unknown) => e
        );
        assert(error instanceof Error);
        expect(error.message).toBe("OIDC_ADDITIONAL_JWKS is not valid JSON");
    });
});
