import { describe, expect, it } from "vitest";
import { approvableScopeIds, scopeCategories } from "@/lib/scopes";

describe("scopeCategories", () => {
    it("should have 9 categories", () => {
        expect(scopeCategories).toHaveLength(9);
    });

    it("each category should have a label and scopes array", () => {
        for (const cat of scopeCategories) {
            expect(cat.label).toBeTypeOf("string");
            expect(cat.label.length).toBeGreaterThan(0);
            expect(Array.isArray(cat.scopes)).toBe(true);
        }
    });

    it("should have all known scope categories", () => {
        const labels = scopeCategories.map((c) => c.label);
        expect(labels).toContain("Repository Contents");
        expect(labels).toContain("Issues");
        expect(labels).toContain("Pull Requests");
        expect(labels).toContain("Actions & CI");
        expect(labels).toContain("Metadata");
        expect(labels).toContain("Administration");
        expect(labels).toContain("Security & Access");
        expect(labels).toContain("Pages & Webhooks");
        expect(labels).toContain("Environments");
    });

    it("each scope should have unique id within its category", () => {
        for (const cat of scopeCategories) {
            const ids = cat.scopes.map((s) => s.id);
            expect(new Set(ids).size).toBe(ids.length);
        }
    });

    it("each scope should have id and description", () => {
        let total = 0;
        for (const cat of scopeCategories) {
            for (const scope of cat.scopes) {
                expect(scope.id).toBeTypeOf("string");
                expect(scope.description).toBeTypeOf("string");
                expect(scope.id.length).toBeGreaterThan(0);
                expect(scope.description.length).toBeGreaterThan(0);
                total++;
            }
        }
        // Verify total known scope count
        expect(total).toBeGreaterThanOrEqual(24);
    });

    it("all scope ids should be named permission scopes or legacy presets", () => {
        for (const cat of scopeCategories) {
            for (const scope of cat.scopes) {
                expect(scope.id).toMatch(/^[a-z]+:[a-z]+$|^admin$/);
            }
        }
    });

    it("describes the legacy admin preset explicitly", () => {
        const scopes = scopeCategories.flatMap((c) => c.scopes);
        expect(scopes).toContainEqual({
            id: "admin",
            description:
                "Full admin access (contents, workflows, and repository administration)",
        });
    });

    it("should not have duplicate scope ids across categories", () => {
        const allIds = scopeCategories.flatMap((c) =>
            c.scopes.map((s) => s.id)
        );
        expect(new Set(allIds).size).toBe(allIds.length);
    });

    it("approvableScopeIds contains granular scopes and visible legacy presets", () => {
        expect(approvableScopeIds.has("contents:read")).toBe(true);
        // admin is a visible scope in the UI categories (not hidden),
        // so it is included in approvableScopeIds.
        expect(approvableScopeIds.has("admin")).toBe(true);
        // contents:write+workflows:write is not in the UI categories,
        // so it remains excluded.
        expect(approvableScopeIds.has("contents:write+workflows:write")).toBe(
            false
        );
    });
});
