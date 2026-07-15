import { describe, expect, it } from "vitest";
import { TokenExpiredError } from "@/errors";

describe("TokenExpiredError", () => {
    it("is an instance of Error", () => {
        const err = new TokenExpiredError();
        expect(err).toBeInstanceOf(Error);
    });

    it("has the correct name", () => {
        const err = new TokenExpiredError();
        expect(err.name).toBe("TokenExpiredError");
    });

    it("uses default message when none provided", () => {
        const err = new TokenExpiredError();
        expect(err.message).toBe("GitHub token expired or invalid");
    });

    it("uses custom message when provided", () => {
        const err = new TokenExpiredError("Custom error message");
        expect(err.message).toBe("Custom error message");
    });

    it("can be thrown and caught", () => {
        expect(() => {
            throw new TokenExpiredError();
        }).toThrow(TokenExpiredError);
    });

    it("preserves stack trace", () => {
        const err = new TokenExpiredError();
        expect(err.stack).toBeTruthy();
    });
});
