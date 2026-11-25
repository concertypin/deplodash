import { describe, expect, it } from "vitest";
import { apiErrorMessage, isSignedInUser } from "@/lib/session";

describe("isSignedInUser", () => {
    it("accepts a login with an avatar URL", () => {
        expect(isSignedInUser({ login: "owner", avatarUrl: "" })).toBe(true);
    });

    it.each([
        ["null", null],
        ["a string", "owner"],
        ["a missing avatarUrl", { login: "owner" }],
        ["a non-string login", { login: 1, avatarUrl: "" }],
    ])("rejects %s", (_label, value) => {
        expect(isSignedInUser(value)).toBe(false);
    });
});

describe("apiErrorMessage", () => {
    it("returns the error string of an API error body", () => {
        expect(apiErrorMessage({ error: "Forbidden" })).toBe("Forbidden");
    });

    it.each([
        ["null", null],
        ["a body without error", { status: "ok" }],
        ["a non-string error", { error: { code: 1 } }],
    ])("returns null for %s", (_label, value) => {
        expect(apiErrorMessage(value)).toBeNull();
    });
});
