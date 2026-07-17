import { describe, expect, it, beforeEach } from "vitest";
import {
    base64UrlEncode,
    randomBytes,
    encryptWith,
    decryptWith,
    initKey,
    getOrInitKey,
    resetKeyCache,
    pkceChallenge,
} from "@/crypto";

describe("base64UrlEncode", () => {
    it("encodes empty input", () => {
        expect(base64UrlEncode(new Uint8Array(0))).toBe("");
    });

    it("encodes simple bytes", () => {
        const input = new TextEncoder().encode("hello");
        const result = base64UrlEncode(input);
        // Standard base64 of "hello" is "aGVsbG8=" -> base64url strips "="
        expect(result).toBe("aGVsbG8");
        expect(result).not.toContain("+");
        expect(result).not.toContain("/");
        expect(result).not.toContain("=");
    });

    it("produces URL-safe output", () => {
        // Bytes that produce + and / in base64
        const input = new Uint8Array([0x3e, 0xbf, 0xbf, 0x3e, 0xbf, 0xbf]);
        const result = base64UrlEncode(input);
        expect(result).not.toContain("+");
        expect(result).not.toContain("/");
        expect(result).not.toContain("=");
    });
});

describe("randomBytes", () => {
    it("produces a URL-safe string of expected length", () => {
        const result = randomBytes(32);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
        // Should not contain base64 non-url-safe chars
        expect(result).not.toContain("+");
        expect(result).not.toContain("/");
        expect(result).not.toContain("=");
    });

    it("produces different values on successive calls", () => {
        const a = randomBytes(16);
        const b = randomBytes(16);
        expect(a).not.toBe(b);
    });
});

describe("initKey", () => {
    beforeEach(() => {
        resetKeyCache();
    });

    it("derives a key from a secret string", async () => {
        const key = await initKey("test-secret-1234567890123456");
        expect(key).toBeDefined();
        expect(key.algorithm).toBeDefined();
        expect((key.algorithm as AesKeyAlgorithm).name).toBe("AES-GCM");
    });

    it("throws TypeError when no secret is provided", async () => {
        await expect(initKey(undefined as unknown as string)).rejects.toThrow(
            TypeError
        );
    });

    it("throws with descriptive message when no secret", async () => {
        await expect(initKey(undefined as unknown as string)).rejects.toThrow(
            "ENCRYPTION_SECRET"
        );
    });
});

describe("getOrInitKey", () => {
    beforeEach(() => {
        resetKeyCache();
    });

    it("returns a key on first call", async () => {
        const key = await getOrInitKey("test-secret-1234567890123456");
        expect(key).toBeDefined();
    });

    it("returns the same key on repeated calls (caching)", async () => {
        resetKeyCache();
        const key1 = await getOrInitKey("test-secret-1234567890123456");
        const key2 = await getOrInitKey("test-secret-1234567890123456");
        expect(key1).toBe(key2);
    });
});

describe("resetKeyCache", () => {
    it("forces a new key derivation on next getOrInitKey call", async () => {
        resetKeyCache();
        const key1 = await getOrInitKey("secret-a");
        resetKeyCache();
        const key2 = await getOrInitKey("secret-b");
        expect(key1).not.toBe(key2);
    });
});

describe("encryptWith / decryptWith", () => {
    let key: CryptoKey;

    beforeEach(async () => {
        resetKeyCache();
        key = await initKey("test-secret-1234567890123456");
    });

    it("round-trips a simple string", async () => {
        const original = "hello world";
        const encrypted = await encryptWith(key, original);
        expect(encrypted).not.toBe(original);
        expect(encrypted).toContain("k1.");

        const decrypted = await decryptWith(key, encrypted);
        expect(decrypted).toBe(original);
    });

    it("round-trips an empty string", async () => {
        const encrypted = await encryptWith(key, "");
        const decrypted = await decryptWith(key, encrypted);
        expect(decrypted).toBe("");
    });

    it("round-trips special characters", async () => {
        const original = "héllo wörld 🔐 <script>alert(1)</script>";
        const encrypted = await encryptWith(key, original);
        const decrypted = await decryptWith(key, encrypted);
        expect(decrypted).toBe(original);
    });

    it("round-trips JSON strings", async () => {
        const original = JSON.stringify({ foo: "bar", num: 42 });
        const encrypted = await encryptWith(key, original);
        const decrypted = await decryptWith(key, encrypted);
        expect(decrypted).toBe(original);
    });

    it("produces different ciphertexts for the same plaintext (IV is random)", async () => {
        const a = await encryptWith(key, "same data");
        const b = await encryptWith(key, "same data");
        expect(a).not.toBe(b);
    });
});

describe("decryptWith error handling", () => {
    let key: CryptoKey;

    beforeEach(async () => {
        resetKeyCache();
        key = await initKey("test-secret-1234567890123456");
    });

    it("returns null for a packet without a dot separator", async () => {
        const result = await decryptWith(key, "invalid-packet-no-dot");
        expect(result).toBeNull();
    });

    it("returns null for a malformed base64 payload", async () => {
        const result = await decryptWith(key, "k1.!!!not-base64!!!");
        expect(result).toBeNull();
    });

    it("returns null for a tampered ciphertext", async () => {
        const encrypted = await encryptWith(key, "secret data");
        // Flip a byte in the ciphertext portion
        const tampered = `${encrypted.slice(0, -5)}XXXXX`;
        const result = await decryptWith(key, tampered);
        expect(result).toBeNull();
    });

    it("returns null for a packet with wrong key", async () => {
        const encrypted = await encryptWith(key, "secret data");
        resetKeyCache();
        const wrongKey = await initKey("different-secret-9999999999999999");
        const result = await decryptWith(wrongKey, encrypted);
        expect(result).toBeNull();
    });

    it("returns null for empty packet", async () => {
        const result = await decryptWith(key, "");
        expect(result).toBeNull();
    });
});

describe("encryptWith / decryptWith with Additional Authenticated Data", () => {
    let key: CryptoKey;

    beforeEach(async () => {
        resetKeyCache();
        key = await initKey("test-secret-1234567890123456");
    });

    it("round-trips with AAD", async () => {
        const original = "sensitive consent data";
        const encrypted = await encryptWith(key, original, "consent-request");
        expect(encrypted).toContain("k1.");
        const decrypted = await decryptWith(key, encrypted, "consent-request");
        expect(decrypted).toBe(original);
    });

    it("returns null when decrypting with wrong AAD", async () => {
        const encrypted = await encryptWith(
            key,
            "secret data",
            "consent-request"
        );
        const result = await decryptWith(key, encrypted, "oauth-state");
        expect(result).toBeNull();
    });

    it("returns null when decrypting with AAD after encrypting without one", async () => {
        const encrypted = await encryptWith(key, "secret data");
        const result = await decryptWith(key, encrypted, "consent-request");
        expect(result).toBeNull();
    });

    it("returns null when decrypting without AAD after encrypting with one", async () => {
        const encrypted = await encryptWith(
            key,
            "secret data",
            "consent-request"
        );
        const result = await decryptWith(key, encrypted);
        expect(result).toBeNull();
    });

    it("purpose separation: oauth-state vs consent-request AAD produce incompatible ciphertexts", async () => {
        const data = JSON.stringify({ v: "verifier", n: "/" });
        const encryptedOAuth = await encryptWith(key, data, "oauth-state");
        const encryptedConsent = await encryptWith(
            key,
            data,
            "consent-request"
        );

        // Each with matching AAD succeeds
        expect(await decryptWith(key, encryptedOAuth, "oauth-state")).toBe(
            data
        );
        expect(
            await decryptWith(key, encryptedConsent, "consent-request")
        ).toBe(data);

        // Cross-purpose decryption fails
        expect(
            await decryptWith(key, encryptedOAuth, "consent-request")
        ).toBeNull();
        expect(
            await decryptWith(key, encryptedConsent, "oauth-state")
        ).toBeNull();
    });

    it("round-trips with empty string AAD", async () => {
        const original = "data with empty AAD";
        const encrypted = await encryptWith(key, original, "");
        const decrypted = await decryptWith(key, encrypted, "");
        expect(decrypted).toBe(original);
    });
});

describe("pkceChallenge", () => {
    it("returns a URL-safe base64 string", async () => {
        const challenge = await pkceChallenge("test-verifier-string");
        expect(typeof challenge).toBe("string");
        expect(challenge.length).toBeGreaterThan(0);
        expect(challenge).not.toContain("+");
        expect(challenge).not.toContain("/");
        expect(challenge).not.toContain("=");
    });

    it("produces consistent results for the same verifier", async () => {
        const a = await pkceChallenge("same-verifier");
        const b = await pkceChallenge("same-verifier");
        expect(a).toBe(b);
    });

    it("produces different results for different verifiers", async () => {
        const a = await pkceChallenge("verifier-a");
        const b = await pkceChallenge("verifier-b");
        expect(a).not.toBe(b);
    });

    it("handles empty verifier string", async () => {
        const challenge = await pkceChallenge("");
        expect(typeof challenge).toBe("string");
        expect(challenge.length).toBeGreaterThan(0);
    });
});
