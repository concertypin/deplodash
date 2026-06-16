import { describe, expect, it } from "vitest";
import { renderPage, LoginPage, ConsentPage } from "@/views";
import HomePage from "@/views/HomePage";
import { Navbar } from "@/views/Navbar";
import { Sidebar } from "@/views/Sidebar";

describe("renderPage", () => {
    it("prepends <!DOCTYPE html>", () => {
        const result = renderPage(<div>content</div>);
        expect(result).toBe("<!DOCTYPE html>\n<div>content</div>");
    });
});

/** Strip the `<!DOCTYPE html>\n` prefix that renderPage adds. */
function renderContent(element: Parameters<typeof renderPage>[0]): string {
    const full = renderPage(element);
    return full.replace(/^<!DOCTYPE html>\n/, "");
}

describe("LoginPage", () => {
    it("renders a login button with the redirect URL", () => {
        const html = renderContent(
            <LoginPage redirectUrl="/auth/github?next=%2F" />
        );
        expect(html).toContain("Login with GitHub");
        expect(html).toContain("/auth/github?next=%2F");
        expect(html).toContain("Deplodash");
        expect(html).toContain("bot");
    });

    it("sets the page title", () => {
        const html = renderContent(<LoginPage redirectUrl="/auth/github" />);
        expect(html).toContain("Deplodash \u2014 Login");
    });
});

describe("ConsentPage", () => {
    const defaultProps = {
        repo: "owner/repo",
        scopes: "contents:read,workflows:write",
    };

    it("renders the consent form with repo and scopes", () => {
        const html = renderContent(<ConsentPage {...defaultProps} />);
        expect(html).toContain("owner/repo");
        expect(html).toContain("Read repository contents");
        expect(html).toContain("Read &amp; write workflow files");
        expect(html).toContain("Authorize Agent Access");
        expect(html).toContain("Confirm");
        expect(html).toContain("Deny");
    });

    it("shows an error alert when error prop is passed", () => {
        const html = renderContent(
            <ConsentPage
                {...defaultProps}
                error="Something went wrong. Please try again."
            />
        );
        expect(html).toContain("Something went wrong. Please try again.");
        expect(html).toContain("alert-error");
    });

    it("shows a success message and hides the form when success is true", () => {
        const html = renderContent(
            <ConsentPage {...defaultProps} success={true} />
        );
        expect(html).toContain("Consent recorded");
        expect(html).toContain("alert-success");
        expect(html).toContain("Back to Dashboard");
        expect(html).not.toContain('method="POST"');
        expect(html).not.toContain("Confirm");
    });

    it("renders unknown scope labels as plain text", () => {
        const html = renderContent(
            <ConsentPage repo="o/r" scopes="custom:scope,another:scope" />
        );
        expect(html).toContain("custom:scope");
        expect(html).toContain("another:scope");
    });

    it("sets the page title to include the repo name", () => {
        const html = renderContent(
            <ConsentPage repo="my-org/my-repo" scopes="contents:read" />
        );
        expect(html).toContain("my-org/my-repo");
    });
});

describe("HomePage", () => {
    const userProps = {
        login: "testuser",
        avatarUrl: "https://example.com/avatar.png",
    };

    it("renders an empty state when there are no consents", () => {
        const html = renderContent(<HomePage {...userProps} consents={[]} />);
        expect(html).toContain("No consents granted yet");
        expect(html).toContain("shield-off");
    });

    it("renders a consent table when consents exist", () => {
        const consents = [
            {
                repo: "owner/repo1",
                scopes: "contents:read",
                granted_at: "2026-06-15T12:00:00Z",
            },
            {
                repo: "owner/repo2",
                scopes: "contents:write,workflows:write",
                granted_at: "2026-06-14T12:00:00Z",
            },
        ];
        const html = renderContent(
            <HomePage {...userProps} consents={consents} />
        );
        expect(html).toContain("Authorized Repositories");
        expect(html).toContain("owner/repo1");
        expect(html).toContain("owner/repo2");
        expect(html).toContain("contents:write");
        expect(html).toContain("Revoke");
        expect(html).not.toContain("No consents granted yet");
    });

    it("displays the user login and avatar", () => {
        const html = renderContent(<HomePage {...userProps} consents={[]} />);
        expect(html).toContain("testuser");
        expect(html).toContain("https://example.com/avatar.png");
    });

    it("shows quick start guide content", () => {
        const html = renderContent(<HomePage {...userProps} consents={[]} />);
        expect(html).toContain("Quick Start");
        expect(html).toContain("POST /api/token");
    });
});

describe("Navbar", () => {
    it("renders the user login and avatar", () => {
        const html = renderContent(
            <Navbar
                login="testuser"
                avatarUrl="https://example.com/avatar.png"
            />
        );
        expect(html).toContain("testuser");
        expect(html).toContain("Deplodash");
        expect(html).toContain("/logout");
    });

    it("renders an avatar image with correct alt text", () => {
        const html = renderContent(
            <Navbar
                login="testuser"
                avatarUrl="https://example.com/avatar.png"
            />
        );
        expect(html).toContain('alt="testuser"');
    });
});

describe("Sidebar", () => {
    it("renders all navigation links", () => {
        const html = renderContent(<Sidebar />);
        expect(html).toContain("Home");
        expect(html).toContain("Agent Guide");
        expect(html).toContain("API Docs");
        expect(html).toContain("Logout");
        expect(html).toContain("/llms.txt");
        expect(html).toContain("/docs");
        expect(html).toContain("Deplodash");
    });
});
