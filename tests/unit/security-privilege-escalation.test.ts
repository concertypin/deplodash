/**
 * Security & Privilege Escalation Tests
 *
 * Targets authorization boundary violations, scope bypass, cross-agent
 * consent access, and other privilege escalation attack vectors that
 * could allow an attacker to gain unauthorized access.
 *
 * Attack vectors tested:
 *   1. Cross-agent consent boundary — Agent A cannot use Agent B's consent
 *   2. findConsentScopes with mismatched agent — null when only other agent has consent
 *   3. Repo name collision in revokeAllConsentsForRepo — substring matching safety
 *   4. findConsentScopes precision — exact hash match before union-intersect fallback
 *   5. Token cache cross-agent isolation — Agent A cannot read Agent B's cached token
 *   6. getAllApprovedScopes agent isolation — returns empty for agent with no consent
 *   7. Cross-agent revoke — Agent A cannot revoke Agent B's consent via revokeAllConsentsForRepo
 *   8. Multiple scopes records same repo — granular scope union across records
 *   9. findConsentScopes empty/nonexistent scopes — null return for non-matching scopes
 *  10. revokeConsent preserves other agents' consents — revoking agent A preserves agent B
 *  11. POST /auth/consent encrypted context cross-repo replay — replay protection
 *  12. POST /auth/consent encrypted context cross-agent replay — agent binding
 *  13. POST /auth/consent without requested_scopes when ENCRYPTION_SECRET set — bypass prevention
 *  14. authGuard GITHUB_TOKEN fallback behavior — documentation of dev bypass
 *  15. findConsentScopes returns null when no agent consents exist at all
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { Hono, type MiddlewareHandler } from "hono";
import type { HonoEnv, SessionPayload } from "@/types";
import { TokenService } from "@/token-service";
import { consentRouter } from "@/routes/consent";
import { sessionMiddleware } from "@/middleware";
import { resetKeyCache, getOrInitKey, encryptWith } from "@/crypto";
import { ConsentOwnershipError } from "@/errors";
import { contains } from "../helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-1234567890123456";

const BASE_ENV: HonoEnv["Bindings"] = {
    ENCRYPTION_SECRET: TEST_SECRET,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    CALLBACK_URL: "http://localhost:5178/callback",
    KV: env.KV,
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
};

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(async () => {
    resetKeyCache();
    const { keys } = await env.KV.list();
    await Promise.all(keys.map((k) => env.KV.delete(k.name)));
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: Cross-Agent Consent Boundaries
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests verify that consents are scoped per-agent. Agent A must NOT be
// able to use consents granted to Agent B — doing so would be a privilege
// escalation allowing any agent to impersonate any other.
//
// Key question: Can agent "malicious" obtain tokens using consents granted to
// agent "victim"?
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cross-Agent Consent Boundaries (Privilege Escalation)", () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(env.KV);
    });

    it("checkConsent rejects agent with no consent when another agent has consent", async () => {
        // Agent "victim" grants consent for repo
        await service.recordConsent("victim", "owner/repo", ["contents:read"]);

        // Agent "malicious" tries to check consent -> should NOT be true
        const result = await service.checkConsent("malicious", "owner/repo", [
            "contents:read",
        ]);
        expect(result).toBe(false);
    });

    it("findConsentScopes returns null for agent that has no consents on the repo", async () => {
        await service.recordConsent("victim", "owner/repo", ["contents:read"]);

        const result = await service.findConsentScopes(
            "malicious",
            "owner/repo",
            ["contents:read"]
        );
        expect(result).toBeNull();
    });

    it("findConsentScopes returns null when no agent has any consents at all", async () => {
        const result = await service.findConsentScopes(
            "any-agent",
            "some/repo",
            ["contents:read"]
        );
        expect(result).toBeNull();
    });

    it("findConsentScopes respects agent isolation with multiple agents on same repo", async () => {
        // Agent alpha has contents:read consent
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        // Agent beta has issues:write consent on the same repo
        await service.recordConsent("beta", "shared/repo", ["issues:write"]);

        // Alpha can only see contents:read
        const alphaScopes = await service.findConsentScopes(
            "alpha",
            "shared/repo",
            ["contents:read"]
        );
        expect(alphaScopes).toEqual(["contents:read"]);

        // Alpha cannot get issues:write
        const alphaIssues = await service.findConsentScopes(
            "alpha",
            "shared/repo",
            ["issues:write"]
        );
        expect(alphaIssues).toBeNull();

        // Beta can only see issues:write
        const betaScopes = await service.findConsentScopes(
            "beta",
            "shared/repo",
            ["issues:write"]
        );
        expect(betaScopes).toEqual(["issues:write"]);

        // Beta cannot get contents:read
        const betaContents = await service.findConsentScopes(
            "beta",
            "shared/repo",
            ["contents:read"]
        );
        expect(betaContents).toBeNull();
    });

    it("getAllApprovedScopes returns empty for agent with no consents, even if other agents have consents", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);

        const result = await service.getAllApprovedScopes(
            "other-agent",
            "shared/repo"
        );
        expect(result).toEqual([]);
    });

    it("revokeConsent does not affect other agents' consents on same repo", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        await service.recordConsent("beta", "shared/repo", ["contents:write"]);

        // Alpha revokes their consent
        await service.revokeConsent("alpha", "shared/repo", ["contents:read"]);

        // Beta's consent should still exist
        const betaCheck = await service.checkConsent("beta", "shared/repo", [
            "contents:write",
        ]);
        expect(betaCheck).toBe(true);

        // Alpha's consent should be gone
        const alphaCheck = await service.checkConsent("alpha", "shared/repo", [
            "contents:read",
        ]);
        expect(alphaCheck).toBe(false);
    });

    it("revokeAllConsentsForRepo with agentId only revokes that agent's consents", async () => {
        await service.recordConsent("alpha", "shared/repo", ["contents:read"]);
        await service.recordConsent("beta", "shared/repo", ["contents:write"]);
        await service.recordConsent("alpha", "other/repo", ["contents:read"]);

        // Revoke alpha's consents for shared/repo only
        await service.revokeAllConsentsForRepo("shared/repo", "alpha");

        // Alpha's shared/repo consent should be gone
        expect(
            await service.checkConsent("alpha", "shared/repo", [
                "contents:read",
            ])
        ).toBe(false);

        // Beta's shared/repo consent should remain
        expect(
            await service.checkConsent("beta", "shared/repo", [
                "contents:write",
            ])
        ).toBe(true);

        // Alpha's other/repo consent should remain (different repo)
        expect(
            await service.checkConsent("alpha", "other/repo", ["contents:read"])
        ).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: Consent Scope Validation
// ═══════════════════════════════════════════════════════════════════════════════
//
// Tests that the consent approval system correctly validates scope boundaries.
// A user should only be able to approve scopes that the agent originally requested.
// The encrypted context prevents tampering and replay attacks.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Consent Scope Validation (Scope Escalation Prevention)", () => {
    let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(() => {
        mockFetch = vi.fn<typeof fetch>();
        mockFetch.mockResolvedValue(
            Response.json({
                login: "testuser",
                id: 1,
                avatar_url: "",
                name: "Test User",
            })
        );
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("rejects consent with scopes not in original request", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "admin",
                    requested_scopes: "contents:read",
                }),
            }),
            authEnv
        );

        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain(
            "Cannot approve scopes not in the original request"
        );
    });

    it("rejects encrypted context cross-repo replay attack", async () => {
        // Attacker scenario:
        // 1. Valid GET for repo "victim/repo" produces encrypted context for that repo
        // 2. Attacker replays the encrypted context on POST for repo "attacker/repo"
        // 3. System must reject because repo in encrypted context doesn't match form repo

        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        // Step 1: GET consent page for victim/repo with contents:read
        const getResp = await app.fetch(
            new Request(
                "http://localhost/auth/consent?repo=victim/repo&scopes=contents:read&agent_id=agent-a"
            ),
            authEnv
        );
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();

        // Extract encrypted context
        const encMatch = getText.match(
            /name="requested_scopes_enc" value="([^"]+)"/
        );
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        // Step 2: Replay on attacker/repo — should be rejected
        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "attacker/repo",
                    scopes: "contents:read",
                    agent_id: "agent-a",
                    requested_scopes_enc: encryptedValue,
                }),
            }),
            authEnv
        );

        expect(postResp.status).toBe(400);
        const postText = await postResp.text();
        expect(postText).toContain("Invalid consent request");
    });

    it("rejects encrypted context cross-agent replay attack", async () => {
        // Attacker scenario:
        // 1. Agent A's GET consent produces encrypted context with agent_id="agent-a"
        // 2. Attacker replays the encrypted context on POST with agent_id="agent-b"
        // 3. System must reject because agent_id in encrypted context doesn't match

        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        // Step 1: GET consent page for agent-a
        const getResp = await app.fetch(
            new Request(
                "http://localhost/auth/consent?repo=shared/repo&scopes=contents:read&agent_id=agent-a"
            ),
            authEnv
        );
        expect(getResp.status).toBe(200);
        const getText = await getResp.text();

        // Extract encrypted context
        const encMatch = getText.match(
            /name="requested_scopes_enc" value="([^"]+)"/
        );
        expect(encMatch).not.toBeNull();
        const encryptedValue = encMatch![1]!;

        // Step 2: Replay with agent-b — should be rejected
        const postResp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "shared/repo",
                    scopes: "contents:read",
                    agent_id: "agent-b",
                    requested_scopes_enc: encryptedValue,
                }),
            }),
            authEnv
        );

        expect(postResp.status).toBe(400);
        const postText = await postResp.text();
        expect(postText).toContain("Invalid consent request");
    });

    it("rejects POST without requested_scopes_enc when ENCRYPTION_SECRET is configured", async () => {
        // This prevents bypassing subset validation by omitting the encrypted context.
        // When ENCRYPTION_SECRET is set but no encrypted field is submitted,
        // the POST handler must reject the request.

        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        // POST without requested_scopes_enc AND without requested_scopes
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "contents:read",
                }),
            }),
            authEnv
        );

        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain("Invalid consent request");
    });

    it("rejects tampered encrypted context value", async () => {
        const authEnv: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_test_user_token",
        };
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", consentRouter);

        // Send a garbage encrypted value
        const resp = await app.fetch(
            new Request("http://localhost/auth/consent", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    repo: "owner/repo",
                    scopes: "contents:read",
                    agent_id: "test-agent",
                    requested_scopes_enc: "AAAA.BBBa5nRhaW5lZFN0cmluZw.CCC.DDD",
                }),
            }),
            authEnv
        );

        expect(resp.status).toBe(400);
        const text = await resp.text();
        expect(text).toContain("Invalid consent request");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: Repo Name Collision Safety
// ═══════════════════════════════════════════════════════════════════════════════
//
// revokeAllConsentsForRepo uses suffix matching via .includes("repo:")
// on the key suffix. This must not match repo names that happen to share
// a common prefix (e.g., "org/my" must not match "org/my-other" or
// "org/myrepo").
// ═══════════════════════════════════════════════════════════════════════════════

describe("Repo Name Collision Safety in revokeAllConsentsForRepo", () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(env.KV);
    });

    it("does not revoke consents for repo names sharing a prefix", async () => {
        // Set up consents for repos with similar names
        await service.recordConsent("agent-a", "org/my", ["contents:read"]);
        await service.recordConsent("agent-a", "org/my-other", [
            "contents:write",
        ]);
        await service.recordConsent("agent-a", "org/myrepo", ["issues:read"]);

        // Revoke all consents for "org/my"
        await service.revokeAllConsentsForRepo("org/my");

        // "org/my" should be revoked
        expect(
            await service.checkConsent("agent-a", "org/my", ["contents:read"])
        ).toBe(false);

        // Similar-named repos should NOT be affected
        expect(
            await service.checkConsent("agent-a", "org/my-other", [
                "contents:write",
            ])
        ).toBe(true);

        expect(
            await service.checkConsent("agent-a", "org/myrepo", ["issues:read"])
        ).toBe(true);
    });

    it("does not revoke consents for repos with dot-prefix similarity", async () => {
        await service.recordConsent("agent-a", "org/my.repo", [
            "contents:read",
        ]);
        await service.recordConsent("agent-a", "org/my-repo", [
            "contents:write",
        ]);

        await service.revokeAllConsentsForRepo("org/my.repo");

        expect(
            await service.checkConsent("agent-a", "org/my.repo", [
                "contents:read",
            ])
        ).toBe(false);

        // Similar name with dash should not be affected
        expect(
            await service.checkConsent("agent-a", "org/my-repo", [
                "contents:write",
            ])
        ).toBe(true);
    });

    it("correctly handles cross-agent revoke with similar repo names", async () => {
        // Cross-agent revoke: no agentId, slow path suffix matching
        await service.recordConsent("agent-a", "org/my", ["contents:read"]);
        await service.recordConsent("agent-b", "org/mine", ["contents:write"]);

        await service.revokeAllConsentsForRepo("org/my");

        expect(
            await service.checkConsent("agent-a", "org/my", ["contents:read"])
        ).toBe(false);

        // "org/mine" should NOT be affected despite having "my" as substring
        // Check: suffix "agent-b:org/mine:hash" includes "org/my:"? No.
        expect(
            await service.checkConsent("agent-b", "org/mine", [
                "contents:write",
            ])
        ).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: Token Cache Isolation
// ═══════════════════════════════════════════════════════════════════════════════
//
// Cached tokens must be scoped per-agent to prevent one agent from
// using another agent's cached installation token.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Token Cache Cross-Agent Isolation", () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(env.KV);
    });

    it("getCachedToken returns null for agent that did not cache the token", async () => {
        const future = new Date(Date.now() + 3600_000).toISOString();

        await service.cacheToken(
            "agent-a",
            "shared/repo",
            ["contents:read"],
            "ghs_alpha_token",
            future
        );

        // Agent B should not see agent A's cached token
        const cachedB = await service.getCachedToken("agent-b", "shared/repo", [
            "contents:read",
        ]);
        expect(cachedB).toBeNull();

        // Agent A should still see it
        const cachedA = await service.getCachedToken("agent-a", "shared/repo", [
            "contents:read",
        ]);
        expect(cachedA).not.toBeNull();
        expect(cachedA!.token).toBe("ghs_alpha_token");
    });

    it("requestToken with mismatched agent does not use another agent's cached token", async () => {
        // Agent A has consent and caches a token
        await service.recordConsent("agent-a", "shared/repo", [
            "contents:read",
        ]);
        const future = new Date(Date.now() + 3600_000).toISOString();
        await service.cacheToken(
            "agent-a",
            "shared/repo",
            ["contents:read"],
            "ghs_alpha_token",
            future
        );

        let callCount = 0;
        const getToken = () => {
            callCount++;
            return Promise.resolve({
                token: `ghs_new_${callCount}`,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
            });
        };

        // Agent B has no consent — should get needs_consent, not agent A's cached token
        const resultB = await service.requestToken(
            {
                repo: "shared/repo",
                scopes: ["contents:read"],
                baseUrl: "http://test",
                agentId: "agent-b",
            },
            getToken
        );

        expect(resultB.status).toBe("needs_consent");
        expect(callCount).toBe(0); // getToken should not have been called
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: Granular Scopes — findConsentScopes Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════
//
// findConsentScopes supports granular consent: if the user approved individual
// scopes across multiple consent records, the union is intersected with the
// agent's requested scopes. These tests verify the boundary behavior.
// ═══════════════════════════════════════════════════════════════════════════════

describe("findConsentScopes — Granular Scopes & Edge Cases", () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(env.KV);
    });

    it("returns exact match when hash matches (fast path)", async () => {
        await service.recordConsent("agent-a", "repo/one", [
            "contents:read",
            "issues:read",
        ]);

        // Exact same scopes → fast path hash hit
        const result = await service.findConsentScopes("agent-a", "repo/one", [
            "contents:read",
            "issues:read",
        ]);
        expect(result).toEqual(["contents:read", "issues:read"]);
    });

    it("returns subset when exact hash misses but union-intersect matches", async () => {
        // User approved contents:read + issues:write in one record
        await service.recordConsent("agent-a", "repo/two", [
            "contents:read",
            "issues:write",
        ]);

        // Agent only requests contents:read — should match via union-intersect
        const result = await service.findConsentScopes("agent-a", "repo/two", [
            "contents:read",
        ]);
        expect(result).toEqual(["contents:read"]);
    });

    it("returns null when no overlap between requested and approved scopes", async () => {
        await service.recordConsent("agent-a", "repo/three", [
            "contents:read",
            "issues:read",
        ]);

        // Agent requests scopes that are not in approved set
        const result = await service.findConsentScopes(
            "agent-a",
            "repo/three",
            ["admin"]
        );
        expect(result).toBeNull();
    });

    it("returns union of scopes across multiple consent records for same repo", async () => {
        // User approved contents:read in first session
        await service.recordConsent("agent-a", "repo/four", ["contents:read"]);
        // User approved issues:write in second session
        await service.recordConsent("agent-a", "repo/four", ["issues:write"]);

        // Agent requests both — should get union via getAllApprovedScopes
        const result = await service.findConsentScopes("agent-a", "repo/four", [
            "contents:read",
            "issues:write",
        ]);
        expect(result).toContain("contents:read");
        expect(result).toContain("issues:write");
    });

    it("returns null for scopes not matching when no consent exists at all", async () => {
        const result = await service.findConsentScopes("ghost", "no/consent", [
            "contents:read",
        ]);
        expect(result).toBeNull();
    });

    it("handles empty scope list gracefully", async () => {
        await service.recordConsent("agent-a", "repo/empty", ["contents:read"]);

        // Empty requested scopes — should not match anything
        const result = await service.findConsentScopes(
            "agent-a",
            "repo/empty",
            []
        );
        expect(result).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: Authorization Boundary for Admin-Endpoint-Like Operations
// ═══════════════════════════════════════════════════════════════════════════════
//
// Tests for authorization failures that could allow privilege escalation
// in session-based access control.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Session-Based Authorization Boundaries", () => {
    it("authGuard renders login page when no token is available", async () => {
        // No GITHUB_TOKEN, no session cookie — authGuard should block with login page
        const { authGuard } = await import("@/middleware");
        const app = new Hono<HonoEnv>()
            .use("*", (async (c, next) => {
                // Skip sessionMiddleware, directly use authGuard without gh_token
                return authGuard()(c, next);
            }) satisfies MiddlewareHandler<HonoEnv>)
            .get("/protected", (c) => c.json({ secret: "data" }));

        const resp = await app.fetch(
            new Request("http://localhost/protected"),
            BASE_ENV
        );
        expect(resp.status).toBe(200);
        const text = await resp.text();
        // Should render login page, not the protected resource
        expect(text).toContain("Login with GitHub");
        expect(text).toContain("/auth/github");
    });

    it("authGuard uses GITHUB_TOKEN as fallback (dev bypass)", async () => {
        // This documents the dev bypass behavior:
        // When GITHUB_TOKEN is set, authGuard uses it even without a session cookie.
        // In production, GITHUB_TOKEN should NOT be configured.
        const envWithToken: HonoEnv["Bindings"] = {
            ...BASE_ENV,
            GITHUB_TOKEN: "ghp_dev_bypass_token",
        };
        const { authGuard } = await import("@/middleware");
        const app = new Hono<HonoEnv>()
            .use("*", authGuard())
            .get("/protected", (c) => c.json({ status: "ok" }));

        const resp = await app.fetch(
            new Request("http://localhost/protected"),
            envWithToken
        );
        expect(resp.status).toBe(200);
        const body = await resp.json();
        contains(body, "status");
        expect(body.status).toBe("ok");
    });

    it("sessionMiddleware does not set gh_token with tampered cookie", async () => {
        // Attacker modifies the session cookie value — must be rejected
        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .get("/check", (c) => {
                const token = c.get("gh_token");
                return c.json({ hasToken: !!token });
            });

        const resp = await app.fetch(
            new Request("http://localhost/check", {
                headers: {
                    Cookie: "session=tampered.invalid.value",
                },
            }),
            BASE_ENV
        );

        expect(resp.status).toBe(200);
        const body = await resp.json();
        // Tampered cookie should NOT result in gh_token being set
        contains(body, "hasToken");
        expect(body?.hasToken).toBe(false);
    });

    it("sessionMiddleware does not set gh_token with expired session", async () => {
        // Create a session payload where both access token AND refresh token are expired
        const key = await getOrInitKey(TEST_SECRET);
        const past = Date.now() - 100_000; // 100 seconds ago
        const expiredPayload: SessionPayload = {
            accessToken: "ghp_expired",
            refreshToken: "refresh_expired",
            accessExpiresAt: past,
            refreshExpiresAt: past,
        };
        const encrypted = await encryptWith(
            key,
            JSON.stringify(expiredPayload)
        );
        const cookie = `session=${encrypted}`;

        const app = new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .get("/check", (c) => {
                const token = c.get("gh_token");
                return c.json({ hasToken: !!token });
            });

        const resp = await app.fetch(
            new Request("http://localhost/check", {
                headers: { Cookie: cookie },
            }),
            BASE_ENV
        );

        expect(resp.status).toBe(200);
        const body = await resp.json();
        // Both tokens expired → cookie cleared, gh_token should not be set
        contains(body, "hasToken");
        expect(body.hasToken).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: Consent Ownership — Prevent Cross-User Revocation
// ═══════════════════════════════════════════════════════════════════════════════
//
// A user should not be able to revoke another user's consent.
// Already tested in token-service.test.ts but we add additional edge cases.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Consent Ownership — Cross-User Revocation Prevention", () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(env.KV);
    });

    it("revokeConsent throws ConsentOwnershipError when caller does not match granted_by with mixed-case login", async () => {
        await service.recordConsent(
            "agent-a",
            "repo/alpha",
            ["contents:read"],
            undefined,
            "UserA" // Mixed case
        );

        // Different case should still fail (comparison is case-sensitive)
        await expect(
            service.revokeConsent(
                "agent-a",
                "repo/alpha",
                ["contents:read"],
                "userA"
            )
        ).rejects.toThrow(ConsentOwnershipError);
    });

    it("revokeConsent succeeds for the exact matching user", async () => {
        await service.recordConsent(
            "agent-a",
            "repo/alpha",
            ["contents:read"],
            undefined,
            "UserA"
        );

        await expect(
            service.revokeConsent(
                "agent-a",
                "repo/alpha",
                ["contents:read"],
                "UserA"
            )
        ).resolves.toBeUndefined();
    });

    it("revokeConsent with caller succeeds on records without granted_by (old format)", async () => {
        // Old format record — no granted_by field
        await service.recordConsent("agent-a", "legacy/repo", [
            "contents:read",
        ]);

        // Any caller can revoke old-format records (they have no owner)
        await expect(
            service.revokeConsent(
                "agent-a",
                "legacy/repo",
                ["contents:read"],
                "anyone"
            )
        ).resolves.toBeUndefined();

        const check = await service.checkConsent("agent-a", "legacy/repo", [
            "contents:read",
        ]);
        expect(check).toBe(false);
    });

    it("revokeConsent denies cross-user even with multiple agents on same repo", async () => {
        // UserA grants consent to agent-a
        await service.recordConsent(
            "agent-a",
            "shared/repo",
            ["contents:read"],
            undefined,
            "UserA"
        );
        // UserB grants consent to agent-b
        await service.recordConsent(
            "agent-b",
            "shared/repo",
            ["contents:write"],
            undefined,
            "UserB"
        );

        // UserB cannot revoke agent-a's consent
        await expect(
            service.revokeConsent(
                "agent-a",
                "shared/repo",
                ["contents:read"],
                "UserB"
            )
        ).rejects.toThrow(ConsentOwnershipError);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: Malformed Data Attack Surface
// ═══════════════════════════════════════════════════════════════════════════════
//
// Malformed records in KV should not grant unintended access or cause
// privilege escalation by being interpreted as valid consents.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Malformed Data Attack Surface", () => {
    let service: TokenService;

    beforeEach(() => {
        service = new TokenService(env.KV);
    });

    it("getAllApprovedScopes ignores malformed consent records", async () => {
        // Insert a mix: one valid, one malformed (missing required fields), one with invalid JSON
        await service.recordConsent("agent-a", "repo/valid", ["contents:read"]);

        // Malformed: missing scopes field
        await env.KV.put(
            "consent:agent-a:repo/valid:badhash1",
            JSON.stringify({
                repo: "repo/valid",
                granted_at: "2026-01-01T00:00:00Z",
            })
        );

        // Malformed: completely unrelated JSON
        await env.KV.put(
            "consent:agent-a:repo/valid:badhash2",
            JSON.stringify({ foo: "bar" })
        );

        // getApprovedScopes should only return scopes from the valid record
        const scopes = await service.getAllApprovedScopes(
            "agent-a",
            "repo/valid"
        );
        expect(scopes).toEqual(["contents:read"]);
    });

    it("checkConsent returns false when consent record is malformed", async () => {
        // Store a malformed record for the key that would normally match
        const { hashScopes } = await import("@/helpers");
        const hash = await hashScopes(["contents:read"]);
        const key = `consent:agent-a:repo/malformed:${hash}`;
        await env.KV.put(
            key,
            JSON.stringify({ granted_at: "2026-01-01T00:00:00Z" }) // No repo or scopes
        );

        const result = await service.checkConsent("agent-a", "repo/malformed", [
            "contents:read",
        ]);
        expect(result).toBe(false);
    });

    it("malformed consent record is cleaned up when encountered through requestToken", async () => {
        const { hashScopes } = await import("@/helpers");
        const hash = await hashScopes(["contents:read"]);
        const key = `consent:agent-a:repo/cleanup:${hash}`;
        await env.KV.put(
            key,
            JSON.stringify({
                granted_at: "2026-01-01T00:00:00Z",
                repo: "repo/cleanup",
            }) // No scopes
        );

        // requestToken internally calls findConsentScopes → parseConsentRecord which
        // attempts malformed record cleanup via fire-and-forget delete (void).
        // The additional async work in requestToken gives the delete time to complete.
        const result = await service.requestToken(
            {
                repo: "repo/cleanup",
                scopes: ["contents:read"],
                baseUrl: "http://test",
                agentId: "agent-a",
            },
            () =>
                Promise.resolve({
                    token: "ghs_test",
                    expires_at: new Date(Date.now() + 3600000).toISOString(),
                })
        );

        expect(result.status).toBe("needs_consent");

        // The malformed record should be deleted after requestToken processes it
        const stillExists = await env.KV.get(key);
        expect(stillExists).toBeNull();
    });
});
