import {
    afterEach,
    assert,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import * as z from "zod";
import { env } from "cloudflare:workers";
import { router } from "@/route";
import { randomBytes, resetKeyCache } from "@/crypto";
import { OidcConsentService } from "@/oidc/consent";
import { parseAudience } from "@/oidc/audience";
import { resetOidcSignerCache } from "@/oidc/signer";
import { RS256_ALGORITHM } from "@/oidc/jwk";
import {
    findAgentByUid,
    registerAgentToken,
    revokeAgentToken,
    verifyAgentToken,
} from "@/middleware/agent-auth";
import { clearKV, generateTestKeyPair, makeBaseEnv } from "@tests/helpers";

const ISSUER = "https://deplodash.euroka.moe";
const AUDIENCE =
    "https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/agents-pool/providers/deplodash";
const OWNER = { login: "owner", id: 77 };

const needsConsentSchema = z.strictObject({
    status: z.literal("needs_consent"),
    url: z.string(),
    subject: z.string(),
});
const okSchema = z.strictObject({
    status: z.literal("ok"),
    id_token: z.string(),
    token_type: z.literal("urn:ietf:params:oauth:token-type:id_token"),
    expires_at: z.string(),
    subject: z.string(),
});
const errorSchema = z.object({ error: z.string() });
const jwksSchema = z.object({
    keys: z.array(
        z.object({
            kty: z.literal("RSA"),
            n: z.string(),
            e: z.string(),
            kid: z.string(),
        })
    ),
});

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(
        atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)),
        (c) => c.charCodeAt(0)
    );
}

function decodeJson(segment: string): unknown {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

let signingKey: string;
let currentUser = OWNER;

beforeAll(async () => {
    ({ pkcs8Pem: signingKey } = await generateTestKeyPair());
});

beforeEach(async () => {
    resetKeyCache();
    resetOidcSignerCache();
    await clearKV(env.KV);
    currentUser = OWNER;
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() =>
            Promise.resolve(
                Response.json({
                    login: currentUser.login,
                    id: currentUser.id,
                    avatar_url: "",
                    name: null,
                })
            )
        )
    );
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function testEnv(overrides?: Parameters<typeof makeBaseEnv>[0]) {
    return makeBaseEnv({
        KV: env.KV,
        GITHUB_TOKEN: "ghp_test_user_token",
        OIDC_ISSUER: ISSUER,
        OIDC_SIGNING_KEY: signingKey,
        ...overrides,
    });
}

async function createAgent(
    agentId = "gcp-agent",
    owner: { login: string; id: number } | null = OWNER
): Promise<string> {
    const token = `tok_${agentId}_${randomBytes(12)}`;
    await registerAgentToken(
        env.KV,
        token,
        agentId,
        undefined,
        owner?.login,
        owner?.id
    );
    return token;
}

function requestToken(
    agentToken: string | null,
    audience: string = AUDIENCE,
    environment = testEnv()
) {
    return router.request(
        "/api/oidc/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(agentToken
                    ? { Authorization: `Bearer ${agentToken}` }
                    : {}),
            },
            body: JSON.stringify({ audience }),
        },
        environment
    );
}

function postConsent(
    path: "/api/consent/oidc" | "/api/consent/oidc/revoke",
    body: { agent_uid: string; audience: string },
    headers: Record<string, string> = {}
) {
    return router.request(
        `http://localhost${path}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
        },
        testEnv()
    );
}

async function uidOf(agentToken: string): Promise<string> {
    const info = await verifyAgentToken(env.KV, agentToken);
    assert(info?.uid);
    return info.uid;
}

describe("POST /api/oidc/token", () => {
    it("returns 401 without an agent token", async () => {
        expect((await requestToken(null)).status).toBe(401);
    });

    it("returns 503 when the issuer is not configured", async () => {
        const agent = await createAgent();
        const res = await requestToken(
            agent,
            AUDIENCE,
            testEnv({ OIDC_SIGNING_KEY: "" })
        );
        expect(res.status).toBe(503);
        expect(errorSchema.parse(await res.json()).error).toBe(
            "OIDC issuer is not configured"
        );
    });

    it("returns 400 for an audience no relying party accepts", async () => {
        const agent = await createAgent();
        const res = await requestToken(agent, "https://evil.example/aud");
        expect(res.status).toBe(400);
        expect(errorSchema.parse(await res.json()).error).toMatch(
            /Unsupported audience/
        );
    });

    it("returns 429 when rate limited", async () => {
        const agent = await createAgent();
        const res = await requestToken(
            agent,
            AUDIENCE,
            testEnv({
                TOKEN_RATE_LIMITER: {
                    limit: () => Promise.resolve({ success: false }),
                },
            })
        );
        expect(res.status).toBe(429);
    });

    it("asks for consent with the agent's subject and a consent URL", async () => {
        const agent = await createAgent();
        const res = await requestToken(agent);
        expect(res.status).toBe(202);
        const body = needsConsentSchema.parse(await res.json());
        const uid = await uidOf(agent);
        expect(body.subject).toBe(`agent:${uid}`);

        const url = new URL(body.url);
        // The consent URL points back at this deployment.
        expect(url.origin).toBe("http://localhost");
        expect(url.pathname).toBe("/auth/oidc-consent");
        expect(url.searchParams.get("agent_id")).toBe("gcp-agent");
        expect(url.searchParams.get("agent_uid")).toBe(uid);
        expect(url.searchParams.get("audience")).toBe(AUDIENCE);
    });

    it("canonicalizes the //iam.googleapis.com spelling in the consent URL", async () => {
        const agent = await createAgent();
        const res = await requestToken(agent, AUDIENCE.replace(/^https:/, ""));
        const body = needsConsentSchema.parse(await res.json());
        expect(new URL(body.url).searchParams.get("audience")).toBe(AUDIENCE);
    });

    it("issues a token that verifies against the published JWKS after owner consent", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        expect(
            (
                await postConsent("/api/consent/oidc", {
                    agent_uid: uid,
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(200);

        const res = await requestToken(agent);
        expect(res.status).toBe(200);
        const body = okSchema.parse(await res.json());
        expect(body.subject).toBe(`agent:${uid}`);

        const [header, payload, signature] = body.id_token.split(".");
        assert(header && payload && signature);
        expect(decodeJson(payload)).toMatchObject({
            iss: ISSUER,
            sub: `agent:${uid}`,
            aud: AUDIENCE,
            agent_id: "gcp-agent",
            owner_github_id: OWNER.id,
        });

        // Verify like a relying party: discovery → JWKS → kid → signature.
        const jwksRes = await router.request(
            "/.well-known/jwks.json",
            {},
            testEnv()
        );
        const { keys } = jwksSchema.parse(await jwksRes.json());
        const kid = z.object({ kid: z.string() }).parse(decodeJson(header)).kid;
        const jwk = keys.find((key) => key.kid === kid);
        assert(jwk);
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            { kty: jwk.kty, n: jwk.n, e: jwk.e },
            RS256_ALGORITHM,
            false,
            ["verify"]
        );
        expect(
            await crypto.subtle.verify(
                RS256_ALGORITHM,
                publicKey,
                base64UrlToBytes(signature),
                new TextEncoder().encode(`${header}.${payload}`)
            )
        ).toBe(true);
    });

    it("does not let consent for one audience cover another", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        const other = AUDIENCE.replace("agents-pool", "other-pool");
        expect((await requestToken(agent, other)).status).toBe(202);
    });

    it("rejects agents created before OIDC support and never rewrites them", async () => {
        // Rewriting agent_tokens:* from a request could resurrect a token
        // revoked at another location (KV caches reads for ~60 s), and a
        // backfilled uid could differ per location. Legacy agents get 409.
        const token = "legacy-token";
        await env.KV.put(
            `agent_tokens:${token}`,
            JSON.stringify({
                agent_id: "legacy",
                label: "legacy",
                created_at: "2026-01-01T00:00:00.000Z",
                created_by: OWNER.login,
            })
        );
        const before = await env.KV.get(`agent_tokens:${token}`);

        const res = await requestToken(token);
        expect(res.status).toBe(409);
        expect(errorSchema.parse(await res.json()).error).toMatch(
            /predates OIDC support/
        );
        const waitRes = await router.request(
            "/api/oidc/wait",
            {
                method: "QUERY",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ audience: AUDIENCE }),
            },
            testEnv()
        );
        expect(waitRes.status).toBe(409);

        expect(await env.KV.get(`agent_tokens:${token}`)).toBe(before);
        expect((await env.KV.list({ prefix: "agent_uid:" })).keys).toEqual([]);
    });

    it("rejects a revoked agent token even if its consent records remain", async () => {
        const agent = await createAgent();
        await postConsent("/api/consent/oidc", {
            agent_uid: await uidOf(agent),
            audience: AUDIENCE,
        });
        await revokeAgentToken(env.KV, agent);
        expect((await requestToken(agent)).status).toBe(401);
    });

    it.each([
        ["a missing audience", {}],
        ["an empty audience", { audience: "" }],
        [
            "an audience over 512 characters",
            { audience: `${AUDIENCE}${"a".repeat(512)}` },
        ],
    ])("returns 400 for %s", async (_label, body) => {
        const agent = await createAgent();
        const res = await router.request(
            "/api/oidc/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${agent}`,
                },
                body: JSON.stringify(body),
            },
            testEnv()
        );
        expect(res.status).toBe(400);
    });

    it("returns a generic 500 without internals when signing fails", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await new OidcConsentService(env.KV).grant({
            agentId: "gcp-agent",
            agentUid: uid,
            audience: parseAudience(AUDIENCE)!,
            grantedBy: OWNER.login,
        });
        const res = await requestToken(
            agent,
            AUDIENCE,
            testEnv({ OIDC_SIGNING_KEY: "NOT-A-KEY-SECRET" })
        );
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(text).not.toContain("NOT-A-KEY-SECRET");
        expect(text).not.toContain("OIDC_SIGNING_KEY");
        error.mockRestore();
    });

    it("never carries trust over to an agent re-created under the same agent_id", async () => {
        const original = await createAgent("reused-name");
        const oldUid = await uidOf(original);
        await postConsent("/api/consent/oidc", {
            agent_uid: oldUid,
            audience: AUDIENCE,
        });
        expect((await requestToken(original)).status).toBe(200);

        await revokeAgentToken(env.KV, original);
        const recreated = await createAgent("reused-name");
        const res = await requestToken(recreated);
        expect(res.status).toBe(202);
        const body = needsConsentSchema.parse(await res.json());
        expect(body.subject).not.toBe(`agent:${oldUid}`);
    });
});

describe("POST /api/consent/oidc", () => {
    it("rejects a user who does not own the agent", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        currentUser = { login: "intruder", id: 99 };
        const res = await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        expect(res.status).toBe(403);
        currentUser = OWNER;
        expect((await requestToken(agent)).status).toBe(202);
    });

    it("answers an unknown uid exactly like a foreign agent", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        currentUser = { login: "intruder", id: 99 };
        const foreign = await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        const unknown = await postConsent("/api/consent/oidc", {
            agent_uid: "zzzzzzzzzzzzzzzzzzzzzz",
            audience: AUDIENCE,
        });
        expect(unknown.status).toBe(foreign.status);
        expect(await unknown.json()).toEqual(await foreign.json());
    });

    it("rejects agents without an owner (e.g. provisioned through the CLI)", async () => {
        const agent = await createAgent("cli-agent", null);
        const uid = await uidOf(agent);
        const res = await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        expect(res.status).toBe(403);
    });

    it("rejects a cross-origin request", async () => {
        const agent = await createAgent();
        const res = await postConsent(
            "/api/consent/oidc",
            { agent_uid: await uidOf(agent), audience: AUDIENCE },
            { Origin: "https://evil.example" }
        );
        expect(res.status).toBe(403);
        expect(errorSchema.parse(await res.json()).error).toBe("CSRF detected");
    });

    it("rejects an unsupported audience", async () => {
        const agent = await createAgent();
        const res = await postConsent("/api/consent/oidc", {
            agent_uid: await uidOf(agent),
            audience: "api://AzureADTokenExchange",
        });
        expect(res.status).toBe(400);
    });

    it("never rewrites the agent token record when consent is granted", async () => {
        const agent = await createAgent();
        const before = await env.KV.get(`agent_tokens:${agent}`);
        expect(
            (
                await postConsent("/api/consent/oidc", {
                    agent_uid: await uidOf(agent),
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(200);
        expect((await requestToken(agent)).status).toBe(200);
        expect(await env.KV.get(`agent_tokens:${agent}`)).toBe(before);
    });

    it("revoking consent makes the agent ask again", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        expect((await requestToken(agent)).status).toBe(200);
        expect(
            (
                await postConsent("/api/consent/oidc/revoke", {
                    agent_uid: uid,
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(200);
        expect((await requestToken(agent)).status).toBe(202);
    });

    it("does not let a non-owner revoke", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        currentUser = { login: "intruder", id: 99 };
        expect(
            (
                await postConsent("/api/consent/oidc/revoke", {
                    agent_uid: uid,
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(403);
        currentUser = OWNER;
        expect((await requestToken(agent)).status).toBe(200);
    });
});

describe("QUERY /api/oidc/wait", () => {
    function wait(
        agentToken: string,
        audience: string = AUDIENCE,
        environment = testEnv()
    ) {
        return router.request(
            "/api/oidc/wait",
            {
                method: "QUERY",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${agentToken}`,
                },
                body: JSON.stringify({ audience }),
            },
            environment
        );
    }

    it("returns 204 immediately when consent already exists", async () => {
        const agent = await createAgent();
        await postConsent("/api/consent/oidc", {
            agent_uid: await uidOf(agent),
            audience: AUDIENCE,
        });
        expect((await wait(agent)).status).toBe(204);
    });

    it("wakes up with 204 on the owner's approval, not on the next poll", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        vi.useFakeTimers();
        // The agent waits with the // spelling; the owner approves the
        // https: form. Both must share the canonical waiter key.
        const pending = Promise.resolve(
            wait(agent, AUDIENCE.replace(/^https:/, ""))
        );
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(settled).toBe(false);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        // Far below the 5 s poll interval.
        await vi.advanceTimersByTimeAsync(10);
        expect(settled).toBe(true);
        expect((await pending).status).toBe(204);
    });

    it("returns 400 for an unsupported audience", async () => {
        const agent = await createAgent();
        expect((await wait(agent, "https://evil.example/aud")).status).toBe(
            400
        );
    });

    it("returns 401 without an agent token", async () => {
        const res = await router.request(
            "/api/oidc/wait",
            {
                method: "QUERY",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ audience: AUDIENCE }),
            },
            testEnv()
        );
        expect(res.status).toBe(401);
    });

    it("rate-limits per agent uid", async () => {
        const agent = await createAgent();
        const keys: string[] = [];
        const res = await wait(
            agent,
            AUDIENCE,
            testEnv({
                TOKEN_RATE_LIMITER: {
                    limit: ({ key }: { key: string }) => {
                        keys.push(key);
                        return Promise.resolve({ success: false });
                    },
                },
            })
        );
        expect(res.status).toBe(429);
        expect(keys).toEqual([`oidc:${await uidOf(agent)}`]);
    });

    it("times out with 403", async () => {
        const agent = await createAgent();
        await uidOf(agent);
        vi.useFakeTimers();
        const pending = wait(agent);
        await vi.advanceTimersByTimeAsync(91_000);
        expect((await pending).status).toBe(403);
    });
});

describe("user routes", () => {
    function userRequest(path: string, body?: unknown) {
        return router.request(
            `http://localhost${path}`,
            body === undefined
                ? {}
                : {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                  },
            testEnv()
        );
    }

    it("creates agents with a uid and the owner's GitHub id", async () => {
        const res = await userRequest("/api/user/agent/create", {
            agent_id: "fresh",
        });
        expect(res.status).toBe(200);
        const body = z
            .object({
                token: z.string(),
                info: z.object({ oidc_subject: z.string() }),
            })
            .parse(await res.json());
        const info = await verifyAgentToken(env.KV, body.token);
        expect(info?.created_by_id).toBe(OWNER.id);
        expect(body.info.oidc_subject).toBe(`agent:${info?.uid}`);
    });

    it("lists agents created before OIDC support without a subject", async () => {
        await env.KV.put(
            "agent_tokens:legacy-list",
            JSON.stringify({
                agent_id: "legacy-list",
                label: "legacy-list",
                created_at: "2026-01-01T00:00:00.000Z",
                created_by: OWNER.login,
            })
        );
        const before = await env.KV.get("agent_tokens:legacy-list");
        const res = await userRequest("/api/user/agent/list");
        const { tokens } = z
            .object({
                tokens: z.array(z.looseObject({ agent_id: z.string() })),
            })
            .parse(await res.json());
        expect(tokens).toHaveLength(1);
        expect(tokens[0]).not.toHaveProperty("oidc_subject");
        expect(await env.KV.get("agent_tokens:legacy-list")).toBe(before);
    });

    it("lists only the user's own agents' OIDC consents", async () => {
        // Same agent_id on purpose: only ownership may separate them.
        const mine = await createAgent("shared-name");
        const mineUid = await uidOf(mine);
        await postConsent("/api/consent/oidc", {
            agent_uid: mineUid,
            audience: AUDIENCE,
        });
        const theirs = await createAgent("shared-name", {
            login: "someone-else",
            id: 5,
        });
        await new OidcConsentService(env.KV).grant({
            agentId: "shared-name",
            agentUid: await uidOf(theirs),
            audience: parseAudience(AUDIENCE)!,
            grantedBy: "someone-else",
        });

        const res = await userRequest("/api/user/oidc-consents");
        const { consents } = z
            .object({
                consents: z.array(
                    z.object({
                        agent_id: z.string(),
                        agent_uid: z.string(),
                        audience: z.string(),
                    })
                ),
            })
            .parse(await res.json());
        expect(consents).toEqual([
            expect.objectContaining({
                agent_id: "shared-name",
                agent_uid: mineUid,
                audience: AUDIENCE,
            }),
        ]);
    });

    it("deletes an agent's OIDC consents when the agent is revoked", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        expect(
            (await userRequest("/api/user/agent/revoke", { token: agent }))
                .status
        ).toBe(200);
        const leftover = await env.KV.list({ prefix: `oidc_consent:${uid}:` });
        expect(leftover.keys).toEqual([]);
    });
});

describe("agents with the same agent_id owned by different users", () => {
    const USER_1 = { login: "user-1", id: 1001 };
    const USER_2 = { login: "user-2", id: 1002 };

    it("keeps consent, subject and approval rights separate per agent", async () => {
        // The dashboard rejects duplicate agent_ids, but the CLI and records
        // from before that check can still produce them.
        const agent1 = await createAgent("asdf", USER_1);
        const agent2 = await createAgent("asdf", USER_2);
        const uid1 = await uidOf(agent1);
        const uid2 = await uidOf(agent2);
        expect(uid1).not.toBe(uid2);

        currentUser = USER_1;
        expect(
            (
                await postConsent("/api/consent/oidc", {
                    agent_uid: uid1,
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(200);
        // User 1 cannot approve user 2's "asdf", even with the same name.
        expect(
            (
                await postConsent("/api/consent/oidc", {
                    agent_uid: uid2,
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(403);

        expect((await requestToken(agent1)).status).toBe(200);
        const res2 = await requestToken(agent2);
        expect(res2.status).toBe(202);
        expect(needsConsentSchema.parse(await res2.json()).subject).toBe(
            `agent:${uid2}`
        );
    });

    it("rate-limits each agent separately, not by agent_id", async () => {
        const agent1 = await createAgent("asdf", USER_1);
        const agent2 = await createAgent("asdf", USER_2);
        const keys: string[] = [];
        const environment = testEnv({
            TOKEN_RATE_LIMITER: {
                limit: ({ key }: { key: string }) => {
                    keys.push(key);
                    return Promise.resolve({ success: true });
                },
            },
        });
        await requestToken(agent1, AUDIENCE, environment);
        await requestToken(agent2, AUDIENCE, environment);
        expect(keys).toEqual([
            `oidc:${await uidOf(agent1)}`,
            `oidc:${await uidOf(agent2)}`,
        ]);
    });

    it("lists only the signed-in user's own agent on the dashboard", async () => {
        await createAgent("asdf", USER_1);
        const agent2 = await createAgent("asdf", USER_2);
        currentUser = USER_2;
        const res = await router.request(
            "http://localhost/api/user/agent/list",
            {},
            testEnv()
        );
        const { tokens } = z
            .object({ tokens: z.array(z.object({ oidc_subject: z.string() })) })
            .parse(await res.json());
        expect(tokens).toHaveLength(1);
        expect(tokens[0]!.oidc_subject).toBe(`agent:${await uidOf(agent2)}`);
    });
});

describe("agent ownership", () => {
    it("trusts the numeric GitHub id over a matching login", async () => {
        // A freed login re-registered by someone else must not inherit the
        // original owner's agents.
        const agent = await createAgent("renamed", OWNER);
        currentUser = { login: OWNER.login, id: 999 };
        const res = await postConsent("/api/consent/oidc", {
            agent_uid: await uidOf(agent),
            audience: AUDIENCE,
        });
        expect(res.status).toBe(403);
        expect((await verifyAgentToken(env.KV, agent))?.created_by_id).toBe(
            OWNER.id
        );
    });

    it("still recognizes an owner who renamed their GitHub login", async () => {
        const agent = await createAgent("renamed-owner", OWNER);
        currentUser = { login: "new-login", id: OWNER.id };
        expect(
            (
                await postConsent("/api/consent/oidc", {
                    agent_uid: await uidOf(agent),
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(200);
    });

    it("requires a recorded owner id, even when the login matches", async () => {
        // A record with a uid but only a login (e.g. written by hand or by
        // an old CLI) is not trusted for OIDC: a freed login can be
        // re-registered by someone else.
        const agent = await createAgent("login-only", null);
        const info = await verifyAgentToken(env.KV, agent);
        assert(info);
        await env.KV.put(
            `agent_tokens:${agent}`,
            JSON.stringify({ ...info, created_by: OWNER.login })
        );
        expect(
            (
                await postConsent("/api/consent/oidc", {
                    agent_uid: await uidOf(agent),
                    audience: AUDIENCE,
                })
            ).status
        ).toBe(403);
        expect(
            (await verifyAgentToken(env.KV, agent))?.created_by_id
        ).toBeUndefined();
    });

    it("applies the id-over-login rule on every dashboard route", async () => {
        const agent = await createAgent("guarded", OWNER);
        const uid = await uidOf(agent);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        // Someone holding the original login under a different GitHub id.
        currentUser = { login: OWNER.login, id: 999 };
        const get = (path: string) =>
            router.request(`http://localhost${path}`, {}, testEnv());

        const list = z
            .object({ tokens: z.array(z.unknown()) })
            .parse(await (await get("/api/user/agent/list")).json());
        expect(list.tokens).toEqual([]);

        const consents = z
            .object({ consents: z.array(z.unknown()) })
            .parse(await (await get("/api/user/oidc-consents")).json());
        expect(consents.consents).toEqual([]);

        const revoke = await router.request(
            "http://localhost/api/user/agent/revoke",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: agent }),
            },
            testEnv()
        );
        expect(revoke.status).toBe(403);
        expect(await verifyAgentToken(env.KV, agent)).not.toBeNull();
    });

    it("returns 401 without a session", async () => {
        const agent = await createAgent();
        const res = await router.request(
            "http://localhost/api/consent/oidc",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agent_uid: await uidOf(agent),
                    audience: AUDIENCE,
                }),
            },
            testEnv({ GITHUB_TOKEN: "" })
        );
        expect(res.status).toBe(401);
        expect(await env.KV.list({ prefix: "oidc_consent:" })).toMatchObject({
            keys: [],
        });
    });

    it("returns 401 when the GitHub identity cannot be verified", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(() => Promise.reject(new Error("network down")))
        );
        const res = await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        expect(res.status).toBe(401);
        expect(errorSchema.parse(await res.json()).error).toMatch(
            /Failed to verify identity/
        );
    });

    it("revokes with the // spelling of an https: grant", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await postConsent("/api/consent/oidc", {
            agent_uid: uid,
            audience: AUDIENCE,
        });
        await postConsent("/api/consent/oidc/revoke", {
            agent_uid: uid,
            audience: AUDIENCE.replace(/^https:/, ""),
        });
        expect((await requestToken(agent)).status).toBe(202);
    });

    it("accepts a same-origin request without an Origin header", async () => {
        // Same as the repository consent route: a missing Origin is allowed
        // because the JSON validator and SameSite=Strict cookies already stop
        // cross-site form posts.
        const agent = await createAgent();
        const res = await postConsent("/api/consent/oidc", {
            agent_uid: await uidOf(agent),
            audience: AUDIENCE,
        });
        expect(res.status).toBe(200);
    });

    it.each(["/api/consent/oidc", "/api/consent/oidc/revoke"])(
        "rate-limits %s per client IP",
        async (path) => {
            const agent = await createAgent();
            const keys: string[] = [];
            const res = await router.request(
                `http://localhost${path}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "CF-Connecting-IP": "203.0.113.7",
                    },
                    body: JSON.stringify({
                        agent_uid: await uidOf(agent),
                        audience: AUDIENCE,
                    }),
                },
                testEnv({
                    TOKEN_RATE_LIMITER: {
                        limit: ({ key }: { key: string }) => {
                            keys.push(key);
                            return Promise.resolve({ success: false });
                        },
                    },
                })
            );
            expect(res.status).toBe(429);
            // Namespaced so it cannot collide with oidc:<uid> or repo keys.
            expect(keys).toEqual(["ip:203.0.113.7"]);
        }
    );

    it("shares one consent between the // and https: spellings", async () => {
        const agent = await createAgent();
        await postConsent("/api/consent/oidc", {
            agent_uid: await uidOf(agent),
            audience: AUDIENCE.replace(/^https:/, ""),
        });
        const res = await requestToken(agent, AUDIENCE.replace(/^https:/, ""));
        expect(res.status).toBe(200);
        // The signed aud keeps the requested spelling: Google matches an
        // explicit allowed-audiences list literally.
        const payload = okSchema.parse(await res.json()).id_token.split(".")[1];
        assert(payload);
        expect(decodeJson(payload)).toMatchObject({
            aud: AUDIENCE.replace(/^https:/, ""),
        });
    });
});

describe("agent uid records", () => {
    it("ignores a uid index that outlived its token", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        // e.g. revoked through the CLI, which only deletes agent_tokens:*
        await revokeAgentToken(env.KV, agent);
        expect(await env.KV.get(`agent_uid:${uid}`)).toBe(agent);
        expect(await findAgentByUid(env.KV, uid)).toBeNull();
    });

    it("ignores a uid index pointing at a record with another uid", async () => {
        const agent = await createAgent();
        await env.KV.put("agent_uid:zzzzzzzzzzzzzzzzzzzzzz", agent);
        expect(
            await findAgentByUid(env.KV, "zzzzzzzzzzzzzzzzzzzzzz")
        ).toBeNull();
    });

    it("removes the uid index when the owner revokes the agent", async () => {
        const agent = await createAgent();
        const uid = await uidOf(agent);
        await router.request(
            "http://localhost/api/user/agent/revoke",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: agent }),
            },
            testEnv()
        );
        expect(await env.KV.get(`agent_uid:${uid}`)).toBeNull();
    });
});

describe("QUERY /api/oidc/wait (client disconnect)", () => {
    it("returns 499 when the client aborts", async () => {
        const agent = await createAgent();
        await uidOf(agent);
        const controller = new AbortController();
        const pending = router.request(
            "/api/oidc/wait",
            {
                method: "QUERY",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${agent}`,
                },
                body: JSON.stringify({ audience: AUDIENCE }),
                signal: controller.signal,
            },
            testEnv()
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();
        expect((await pending).status).toBe(499);
    });
});

describe("GET /api/consent/oidc/agent", () => {
    function lookup(agentUid: string) {
        return router.request(
            `http://localhost/api/consent/oidc/agent?agent_uid=${agentUid}`,
            {},
            testEnv()
        );
    }

    it("returns the owner's agent by uid", async () => {
        const agent = await createAgent("looked-up");
        const res = await lookup(await uidOf(agent));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            agent_id: "looked-up",
            label: "looked-up",
        });
    });

    it("answers a foreign uid exactly like an unknown one", async () => {
        const agent = await createAgent("theirs", { login: "someone", id: 5 });
        const foreign = await lookup(await uidOf(agent));
        const unknown = await lookup("zzzzzzzzzzzzzzzzzzzzzz");
        expect(foreign.status).toBe(403);
        expect(unknown.status).toBe(403);
        expect(await foreign.json()).toEqual(await unknown.json());
    });

    it("rejects a malformed uid", async () => {
        expect((await lookup("short")).status).toBe(400);
    });
});

describe("rate-limit key namespaces", () => {
    it("keeps a repo token agent_id from sharing an agent's OIDC bucket", async () => {
        const victim = await createAgent("victim");
        const victimUid = await uidOf(victim);
        // An attacker names their agent after the victim's OIDC bucket.
        const attacker = await createAgent(`oidc:${victimUid}`, {
            login: "attacker",
            id: 666,
        });
        const keys: string[] = [];
        const environment = testEnv({
            TOKEN_RATE_LIMITER: {
                limit: ({ key }: { key: string }) => {
                    keys.push(key);
                    return Promise.resolve({ success: false });
                },
            },
        });
        await router.request(
            "/api/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${attacker}`,
                },
                body: JSON.stringify({ repo: "attacker/repo" }),
            },
            environment
        );
        await requestToken(victim, AUDIENCE, environment);
        expect(keys).toEqual([`repo:oidc:${victimUid}`, `oidc:${victimUid}`]);
    });
});
