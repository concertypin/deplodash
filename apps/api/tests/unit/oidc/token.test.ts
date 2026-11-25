import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { mintIdToken } from "@/oidc/token";
import { resetOidcSignerCache } from "@/oidc/signer";
import type { IssuerConfig } from "@/oidc/issuer";
import { generateTestKeyPair } from "@tests/helpers";

const claimsSchema = z.strictObject({
    iss: z.string(),
    sub: z.string(),
    aud: z.string(),
    iat: z.number(),
    nbf: z.number(),
    exp: z.number(),
    jti: z.string(),
    agent_id: z.string(),
    owner_github_id: z.number().optional(),
});

function decodePayload(jwt: string): unknown {
    const payload = jwt.split(".")[1]!;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
}

let config: IssuerConfig;

beforeAll(async () => {
    const { pkcs8Pem } = await generateTestKeyPair();
    config = {
        issuer: "https://deplodash.euroka.moe",
        jwksUri: "https://deplodash.euroka.moe/.well-known/jwks.json",
        signingKey: pkcs8Pem,
    };
});

beforeEach(() => {
    resetOidcSignerCache();
});

describe("mintIdToken", () => {
    const params = {
        agentUid: "abcdefghijklmnopqrstuv",
        agentId: "my-agent",
        ownerGithubId: 42,
        audience:
            "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/prov",
    };

    it("carries the issuer, subject, audience and a 10-minute lifetime", async () => {
        const now = Date.UTC(2026, 10, 24, 12, 0, 0);
        const { idToken, expiresAt } = await mintIdToken(config, params, now);
        const claims = claimsSchema.parse(decodePayload(idToken));

        expect(claims).toMatchObject({
            iss: "https://deplodash.euroka.moe",
            sub: "agent:abcdefghijklmnopqrstuv",
            aud: params.audience,
            iat: now / 1000,
            nbf: now / 1000,
            exp: now / 1000 + 600,
            agent_id: "my-agent",
            owner_github_id: 42,
        });
        expect(expiresAt).toBe(new Date(now + 600_000).toISOString());
    });

    it("uses a fresh jti for every token", async () => {
        const a = claimsSchema.parse(
            decodePayload((await mintIdToken(config, params)).idToken)
        );
        const b = claimsSchema.parse(
            decodePayload((await mintIdToken(config, params)).idToken)
        );
        expect(a.jti).not.toBe(b.jti);
        expect(a.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it("omits owner_github_id when it is unknown", async () => {
        const { idToken } = await mintIdToken(config, {
            ...params,
            ownerGithubId: undefined,
        });
        expect(claimsSchema.parse(decodePayload(idToken))).not.toHaveProperty(
            "owner_github_id"
        );
    });
});
