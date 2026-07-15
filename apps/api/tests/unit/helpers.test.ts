import { describe, expect, it } from "vitest";
import { escapeHtml, parseRepo, isSafeRedirect } from "@/helpers";

describe("escapeHtml", () => {
    it("escapes special chars", () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe(
            "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
        );
    });

    it("escapes & first", () => {
        expect(escapeHtml("a&b")).toBe("a&amp;b");
        expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    });

    it("passes safe strings", () => {
        expect(escapeHtml("hello world")).toBe("hello world");
        expect(escapeHtml("")).toBe("");
    });
});

describe("parseRepo", () => {
    it("parses valid owner/repo", () => {
        expect(parseRepo("owner/repo")).toEqual({
            owner: "owner",
            repo: "repo",
        });
    });

    it("parses with dots and hyphens", () => {
        expect(parseRepo("my-org/my.repo")).toEqual({
            owner: "my-org",
            repo: "my.repo",
        });
    });

    it("returns null for invalid format", () => {
        expect(parseRepo("invalid")).toBeNull();
        expect(parseRepo("")).toBeNull();
        expect(parseRepo("/repo")).toBeNull();
    });
});

describe("isSafeRedirect", () => {
    it("accepts root path", () => {
        expect(isSafeRedirect("/")).toBe(true);
    });

    it("accepts normal paths", () => {
        expect(isSafeRedirect("/setup")).toBe(true);
        expect(isSafeRedirect("/auth/github")).toBe(true);
    });

    it("rejects protocol-relative URLs", () => {
        expect(isSafeRedirect("//evil.com")).toBe(false);
    });

    it("rejects backslash-normalized protocol-relative URLs", () => {
        // /\/evil.com is normalized by browsers to //evil.com
        expect(isSafeRedirect("/\\/evil.com")).toBe(false);
    });
});
