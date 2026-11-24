import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { router } from "@/route";
import app from "@/index";
import { resetKeyCache } from "@/crypto";
import { resetOidcSignerCache } from "@/oidc/signer";
import { jwkThumbprint } from "@/oidc/jwk";
import { THROWING_KV, generateTestKeyPair, makeBaseEnv } from "@tests/helpers";

const ISSUER = "https://deplodash.euroka.moe";

const jwksSchema = z.object({
    keys: z.array(
        z.strictObject({
            kty: z.literal("RSA"),
            n: z.string(),
            e: z.string(),
            use: z.literal("sig"),
            alg: z.literal("RS256"),
            kid: z.string(),
        })
    ),
});

// Strict: an unexpected member (e.g. key material) fails the parse.
const discoverySchema = z.strictObject({
    issuer: z.string(),
    jwks_uri: z.string(),
    response_types_supported: z.array(z.string()),
    subject_types_supported: z.array(z.string()),
    scopes_supported: z.array(z.string()),
    id_token_signing_alg_values_supported: z.array(z.string()),
    claims_supported: z.array(z.string()),
});

let signingKey: string;
let rotationJwk: { kty: "RSA"; n: string; e: string };

beforeAll(async () => {
    ({ pkcs8Pem: signingKey } = await generateTestKeyPair());
    const { keyPair } = await generateTestKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    rotationJwk = { kty: "RSA", n: jwk.n!, e: jwk.e! };
});

beforeEach(() => {
    resetOidcSignerCache();
    resetKeyCache();
});

function request(path: string, env: ReturnType<typeof makeBaseEnv>) {
    return router.request(path, {}, env);
}

describe("GET /.well-known/* (feature off)", () => {
    it.concurrent.each([
        ["no issuer or key", {}],
        ["issuer without key", { OIDC_ISSUER: ISSUER }],
    ])("returns 404 with %s", async (_label, overrides) => {
        const env = makeBaseEnv({ KV: THROWING_KV, ...overrides });
        for (const path of [
            "/.well-known/openid-configuration",
            "/.well-known/jwks.json",
        ]) {
            const res = await request(path, env);
            expect(res.status).toBe(404);
            // The guard's body, not Hono's default "404 Not Found" for an
            // unregistered route.
            expect(await res.text()).toBe("Not Found");
        }
    });
});

describe("GET /.well-known/openid-configuration", () => {
    it("serves a cacheable discovery document for the issuer", async () => {
        const env = makeBaseEnv({
            KV: THROWING_KV,
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: signingKey,
        });
        const res = await request("/.well-known/openid-configuration", env);
        expect(res.status).toBe(200);
        expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
        const doc = discoverySchema.parse(await res.json());
        expect(doc.issuer).toBe(ISSUER);
        expect(doc.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
        expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"]);
        expect(doc.response_types_supported).toEqual(["id_token"]);
        expect(doc.subject_types_supported).toEqual(["public"]);
        expect(doc.scopes_supported).toEqual(["openid"]);
        expect(doc.claims_supported).toEqual(
            expect.arrayContaining(["iss", "sub", "aud", "exp", "agent_id"])
        );
    });
});

describe("GET /.well-known/jwks.json", () => {
    it("publishes the signing key's public half only", async () => {
        const env = makeBaseEnv({
            KV: THROWING_KV,
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: signingKey,
        });
        const res = await request("/.well-known/jwks.json", env);
        expect(res.status).toBe(200);
        // strictObject: any private member (d, p, q, …) fails the parse.
        const { keys } = jwksSchema.parse(await res.json());
        expect(keys).toHaveLength(1);
    });

    it("appends rotation keys after the active key and drops duplicate kids", async () => {
        const first = jwksSchema.parse(
            await (
                await request(
                    "/.well-known/jwks.json",
                    makeBaseEnv({
                        KV: THROWING_KV,
                        OIDC_ISSUER: ISSUER,
                        OIDC_SIGNING_KEY: signingKey,
                    })
                )
            ).json()
        );
        const active = first.keys[0]!;

        const env = makeBaseEnv({
            KV: THROWING_KV,
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: signingKey,
            OIDC_ADDITIONAL_JWKS: JSON.stringify({
                keys: [
                    rotationJwk,
                    { kty: "RSA", n: active.n, e: active.e },
                    rotationJwk,
                ],
            }),
        });
        const { keys } = jwksSchema.parse(
            await (await request("/.well-known/jwks.json", env)).json()
        );
        expect(keys.map((k) => k.kid)).toEqual([
            active.kid,
            await jwkThumbprint(rotationJwk),
        ]);
    });

    it("returns 503 without key material when the rotation set is invalid", async () => {
        const env = makeBaseEnv({
            KV: THROWING_KV,
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: signingKey,
            OIDC_ADDITIONAL_JWKS: JSON.stringify({
                keys: [{ ...rotationJwk, d: "PRIVATE-MATERIAL" }],
            }),
        });
        const res = await request("/.well-known/jwks.json", env);
        expect(res.status).toBe(503);
        expect(await res.text()).not.toContain("PRIVATE-MATERIAL");
    });

    it("returns 503 when the signing key is malformed", async () => {
        const env = makeBaseEnv({
            KV: THROWING_KV,
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: "garbage",
        });
        expect((await request("/.well-known/jwks.json", env)).status).toBe(503);
    });
});

describe("GET /.well-known/* (session isolation)", () => {
    it("never runs the session middleware", async () => {
        // The session key is cached per isolate; clear it so the empty
        // secret below would really make the middleware throw.
        resetKeyCache();
        // An empty ENCRYPTION_SECRET makes the session middleware throw, so
        // a 200 proves discovery and JWKS are served ahead of it, even when
        // the caller sends a session cookie.
        const env = makeBaseEnv({
            KV: THROWING_KV,
            ENCRYPTION_SECRET: "",
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: signingKey,
        });
        for (const path of [
            "/.well-known/openid-configuration",
            "/.well-known/jwks.json",
        ]) {
            const res = await router.request(
                path,
                { headers: { Cookie: "session=garbage" } },
                env
            );
            expect(res.status).toBe(200);
            expect(res.headers.get("Set-Cookie")).toBeNull();
        }
    });
});

describe("GET /.well-known/<unknown>", () => {
    it("returns 404 instead of the SPA fallback", async () => {
        const assetsFetch = vi.fn<typeof fetch>(() =>
            Promise.resolve(new Response("<html>", { status: 200 }))
        );
        const env = makeBaseEnv({
            KV: THROWING_KV,
            ASSETS: { fetch: assetsFetch },
        });
        const res = await app.request(
            "/.well-known/oauth-authorization-server",
            {},
            env
        );
        expect(res.status).toBe(404);
        expect(assetsFetch).not.toHaveBeenCalled();
    });
});

describe("GET /.well-known/openid-configuration (misconfigured)", () => {
    it("returns 503 when the signing key is malformed", async () => {
        const env = makeBaseEnv({
            KV: THROWING_KV,
            OIDC_ISSUER: ISSUER,
            OIDC_SIGNING_KEY: "garbage",
        });
        const res = await request("/.well-known/openid-configuration", env);
        expect(res.status).toBe(503);
    });
});
