import { describe, expect, it } from "vitest";
import {
    buildConsentUrl,
    escapeHtml,
    parseRepo,
    isSafeRedirect,
} from "@/helpers";

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

describe("buildConsentUrl", () => {
    it("encodes every consent parameter so the consent page can parse it back", () => {
        const url = buildConsentUrl("https://deplodash.example", {
            repo: "owner/repo",
            agentId: "agent &id",
            scopes: ["contents:write", "workflows:write"],
            repoMode: "create-if-missing",
        });
        expect(url).toBe(
            "https://deplodash.example/auth/consent?repo=owner%2Frepo&agent_id=agent%20%26id&scopes=contents%3Awrite%2Cworkflows%3Awrite&repo_mode=create-if-missing"
        );
        const params = new URL(url).searchParams;
        expect(params.get("agent_id")).toBe("agent &id");
        expect(params.get("scopes")).toBe("contents:write,workflows:write");
    });

    it("does not produce a double slash when the base URL ends with one", () => {
        const url = buildConsentUrl("https://deplodash.example//", {
            repo: "owner/repo",
            agentId: "agent",
            scopes: ["contents:read"],
            repoMode: "existing-only",
        });
        expect(new URL(url).pathname).toBe("/auth/consent");
    });
});
