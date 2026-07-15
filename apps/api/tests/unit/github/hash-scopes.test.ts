import { describe, it, expect } from "vitest";
import { hashScopes } from "@/github/scopes";

describe("hashScopes", () => {
    it("returns a consistent hash for the same scopes", async () => {
        const a = await hashScopes(["contents:read", "contents:write"]);
        const b = await hashScopes(["contents:read", "contents:write"]);
        expect(a).toBe(b);
    });

    it("returns different hashes for different scopes", async () => {
        const a = await hashScopes(["contents:read"]);
        const b = await hashScopes(["contents:write"]);
        expect(a).not.toBe(b);
    });

    it("is order-independent", async () => {
        const a = await hashScopes(["contents:write", "contents:read"]);
        const b = await hashScopes(["contents:read", "contents:write"]);
        expect(a).toBe(b);
    });

    it("returns a short string (16 chars)", async () => {
        const hash = await hashScopes(["contents:read"]);
        expect(hash.length).toBe(16);
    });
});
