import { describe, it, expect } from "vitest";
import { expandCompoundScopes } from "@/github/scopes";

describe("expandCompoundScopes", () => {
    it("passes through granular scopes unchanged", () => {
        const result = expandCompoundScopes(["contents:read"]);
        expect(result).toEqual(["contents:read"]);
    });

    it("passes through multiple granular scopes unchanged", () => {
        const result = expandCompoundScopes(["contents:read", "issues:write"]);
        expect(result).toEqual(["contents:read", "issues:write"]);
    });

    it("expands admin compound scope into granular scopes", () => {
        const result = expandCompoundScopes(["admin"]);
        expect(result).toContain("administration:write");
        expect(result).toContain("contents:write");
        expect(result).toContain("workflows:write");
        expect(result).toContain("metadata:read");
        expect(result).toHaveLength(4);
    });

    it("expands contents:write+workflows:write into granular scopes", () => {
        const result = expandCompoundScopes(["contents:write+workflows:write"]);
        expect(result).toContain("contents:write");
        expect(result).toContain("workflows:write");
        expect(result).toContain("metadata:read");
        expect(result).toHaveLength(3);
    });

    it("expands compound and keeps granular scopes interleaved", () => {
        const result = expandCompoundScopes(["admin", "issues:read"]);
        // Check all expected values present
        expect(result).toContain("administration:write");
        expect(result).toContain("contents:write");
        expect(result).toContain("workflows:write");
        expect(result).toContain("metadata:read");
        expect(result).toContain("issues:read");
        expect(result).toHaveLength(5);
    });

    it("deduplicates when compound expansion overlaps with explicit scopes", () => {
        const result = expandCompoundScopes(["admin", "contents:write"]);
        expect(result).toContain("administration:write");
        expect(result).toContain("contents:write");
        expect(result).toContain("workflows:write");
        expect(result).toContain("metadata:read");
        // contents:write appears from both admin and the explicit scope — deduped
        expect(result).toHaveLength(4);
    });

    it("returns empty array for empty input", () => {
        const result = expandCompoundScopes([]);
        expect(result).toEqual([]);
    });
});
