import { describe, expect, it } from "vitest";
import { normalizeKey, escapeHtml, parseRepo, parsePerm } from "@/helpers";

describe("normalizeKey", () => {
    it("strips extra fields beyond algorithm + key", () => {
        expect(
            normalizeKey(
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr nanobot-risuai"
            )
        ).toBe(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr"
        );
    });

    it("handles multiple spaces", () => {
        expect(
            normalizeKey(
                "  ssh-rsa   AAAAB3NzaC1yc2EAAAADAQABAAABAQDC  comment  "
            )
        ).toBe("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDC");
    });

    it("handles minimal key", () => {
        expect(normalizeKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5")).toBe(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"
        );
    });

    it("is idempotent", () => {
        const k =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGKO0OZzvYvj/olDURZA7DvCsnV19GhNyIpCBNX/CAfr";
        expect(normalizeKey(k)).toBe(k);
        expect(normalizeKey(normalizeKey(`${k}   extra`))).toBe(k);
    });
});

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

describe("parsePerm", () => {
    it("returns true for RW", () => {
        expect(parsePerm("RW")).toBe(true);
    });

    it("returns false for RO", () => {
        expect(parsePerm("RO")).toBe(false);
    });

    it("returns true for other values", () => {
        expect(parsePerm("something")).toBe(true);
    });
});
