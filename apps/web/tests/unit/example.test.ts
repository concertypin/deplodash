/// <reference types="node" />
import { describe, expect, expectTypeOf, it } from "vitest";

describe("example test", () => {
    it.concurrent("should pass", () => {
        expect(1 + 1).toBe(2);
        expectTypeOf<"asdf">().toBeString();
    });
    it.concurrent("should run in node environment", () => {
        expect(typeof process).toBe("object");
        expect(typeof process.env).toBe("object");
    });
});
