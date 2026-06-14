import { describe, it, expect } from "vitest";
import { permissionsFromScopes } from "@/github-app";
import { hashScopes } from "@/helpers";

describe("permissionsFromScopes", () => {
    it("returns contents:read permissions for contents:read scope", () => {
        const result = permissionsFromScopes(["contents:read"]);
        expect(result).toEqual({ metadata: "read", contents: "read" });
    });

    it("returns contents:write permissions for contents:write scope", () => {
        const result = permissionsFromScopes(["contents:write"]);
        expect(result).toEqual({ metadata: "read", contents: "write" });
    });

    it("returns combined permissions for contents:write + workflows:write", () => {
        const result = permissionsFromScopes([
            "contents:write",
            "workflows:write",
        ]);
        expect(result).toEqual({
            metadata: "read",
            contents: "write",
            workflows: "write",
        });
    });

    it("returns admin permissions for admin scope", () => {
        const result = permissionsFromScopes(["admin"]);
        expect(result).toEqual({
            metadata: "read",
            contents: "write",
            workflows: "write",
            administration: "write",
        });
    });

    it("handles unknown scope gracefully", () => {
        const result = permissionsFromScopes(["unknown:scope"]);
        expect(result).toEqual({ metadata: "read" });
    });

    it("is idempotent regardless of scope order", () => {
        const a = permissionsFromScopes(["workflows:write", "contents:write"]);
        const b = permissionsFromScopes(["contents:write", "workflows:write"]);
        expect(a).toEqual(b);
    });
});

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
