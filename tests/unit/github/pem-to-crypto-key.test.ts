import { describe, it, expect, beforeAll } from "vitest";
import { pemToCryptoKey } from "@/github/pem-utils";

// ─── RSA Key Setup ───────────────────────────────────────────────────────────

let pkcs8Pem: string;
let pkcs1Pem: string;
let bareBase64: string;

beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
    );

    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const pkcs8Bytes = new Uint8Array(pkcs8);
    const b64 = btoa(String.fromCharCode(...pkcs8Bytes));
    const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
    pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
    bareBase64 = b64;

    let offset = 0;
    if (pkcs8Bytes[0] === 0x30) {
        offset = 2;
        if (pkcs8Bytes[1]! & 0x80) {
            const lenBytes = pkcs8Bytes[1]! & 0x7f;
            offset = 2 + lenBytes;
        }
    }
    offset += 3;
    if (pkcs8Bytes[offset] === 0x30) {
        offset += 2 + pkcs8Bytes[offset + 1]!;
    }
    if (pkcs8Bytes[offset] === 0x04) {
        offset += 1;
        let innerLen = pkcs8Bytes[offset]!;
        if (innerLen & 0x80) {
            const numBytes = innerLen & 0x7f;
            let len = 0;
            for (let i = 0; i < numBytes; i++) {
                len = (len << 8) | pkcs8Bytes[offset + 1 + i]!;
            }
            innerLen = len;
            offset += 1 + numBytes;
        } else {
            offset += 1;
        }
    }
    const pkcs1Bytes = pkcs8Bytes.slice(offset);
    const pkcs1B64 = btoa(String.fromCharCode(...pkcs1Bytes));
    const pkcs1Lines = pkcs1B64.match(/.{1,64}/g)?.join("\n") ?? pkcs1B64;
    pkcs1Pem = `-----BEGIN RSA PRIVATE KEY-----\n${pkcs1Lines}\n-----END RSA PRIVATE KEY-----`;
});

describe("pemToCryptoKey", () => {
    it("accepts a PKCS#8 PEM string", async () => {
        const key = await pemToCryptoKey(pkcs8Pem);
        expect(key).toBeDefined();
        expect((key.algorithm as RsaHashedKeyAlgorithm).name).toBe("RSASSA-PKCS1-v1_5");
        expect(key.type).toBe("private");
    });

    it("accepts a PKCS#1 PEM string (auto-converts to PKCS#8)", async () => {
        const key = await pemToCryptoKey(pkcs1Pem);
        expect(key).toBeDefined();
        expect((key.algorithm as RsaHashedKeyAlgorithm).name).toBe("RSASSA-PKCS1-v1_5");
    });

    it("accepts a base64-encoded PEM string", async () => {
        const encoded = btoa(pkcs8Pem);
        const key = await pemToCryptoKey(encoded);
        expect(key).toBeDefined();
    });

    it("accepts a bare base64 DER body", async () => {
        const key = await pemToCryptoKey(bareBase64);
        expect(key).toBeDefined();
    });

    it("throws on unrecognised format", async () => {
        await expect(pemToCryptoKey("not-a-key!")).rejects.toThrow(/unrecognised key format/i);
    });

    it("throws on empty PEM body", async () => {
        const emptyPem = "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----";
        await expect(pemToCryptoKey(emptyPem)).rejects.toThrow(/empty/i);
    });
});
