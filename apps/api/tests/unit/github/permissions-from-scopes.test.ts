import { describe, it, expect } from "vitest";
import { permissionsFromScopes } from "@/github/scopes";

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

    // ─── Regression guards ──────────────────────────────────────────────────
    // These tests ensure the individual-scope mapping path stays in sync with
    // the LEGACY_PRESETS shortcut path. Both must produce identical results.

    it("produces same result for admin via compound and via expanded scopes", () => {
        const viaPreset = permissionsFromScopes(["admin"]);
        const viaExpanded = permissionsFromScopes([
            "administration:write",
            "contents:write",
            "workflows:write",
            "metadata:read",
        ]);
        expect(viaExpanded).toEqual(viaPreset);
    });

    it("produces same result for contents:write+workflows:write via compound and via expanded scopes", () => {
        const viaPreset = permissionsFromScopes([
            "contents:write+workflows:write",
        ]);
        const viaExpanded = permissionsFromScopes([
            "contents:write",
            "workflows:write",
            "metadata:read",
        ]);
        expect(viaExpanded).toEqual(viaPreset);
    });
});
