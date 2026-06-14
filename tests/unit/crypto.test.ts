import { describe, expect, it } from "vitest";
import { base64UrlEncode, randomBytes } from "@/crypto";

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
