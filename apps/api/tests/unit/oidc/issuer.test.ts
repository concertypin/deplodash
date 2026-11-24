import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildDiscoveryDocument,
    getIssuerConfig,
    normalizeIssuer,
} from "@/oidc/issuer";

describe("normalizeIssuer", () => {
    it.concurrent.each([
        "https://deplodash.euroka.moe",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://[::1]:5173",
    ])("accepts %s unchanged", (issuer) => {
        expect(normalizeIssuer(issuer)).toBe(issuer);
    });

    it.concurrent.each([
        ["missing value", undefined],
        ["empty string", ""],
        ["not a URL", "deplodash.euroka.moe"],
        ["plain http on a public host", "http://deplodash.euroka.moe"],
        ["explicit port on a public host", "https://deplodash.euroka.moe:8443"],
        ["explicit default port", "https://deplodash.euroka.moe:443"],
        ["trailing slash", "https://deplodash.euroka.moe/"],
        ["path", "https://deplodash.euroka.moe/oidc"],
        ["query", "https://deplodash.euroka.moe?x=1"],
        ["fragment", "https://deplodash.euroka.moe#x"],
        ["credentials", "https://user:pass@deplodash.euroka.moe"],
        ["uppercase host (not canonical)", "https://Deplodash.euroka.moe"],
        ["non-http scheme", "ftp://deplodash.euroka.moe"],
        ["uppercase scheme", "HTTPS://deplodash.euroka.moe"],
        ["trailing-dot FQDN", "https://deplodash.euroka.moe."],
        ["IDN (not punycode)", "https://déplodash.euroka.moe"],
        ["public IPv4 literal", "https://192.0.2.1"],
        ["public IPv6 literal", "https://[2001:db8::1]"],
    ])("rejects %s", (_label, issuer) => {
        expect(normalizeIssuer(issuer)).toBeNull();
    });
});

describe("getIssuerConfig", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("is null and silent when the feature is not configured", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(getIssuerConfig({})).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });

    it("warns when the issuer is invalid so a typo is not silent", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(
            getIssuerConfig({
                OIDC_ISSUER: "https://deplodash.euroka.moe/",
                OIDC_SIGNING_KEY: "key",
            })
        ).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/not a canonical https origin/)
        );
    });

    it("warns when only one of issuer and key is set", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(getIssuerConfig({ OIDC_SIGNING_KEY: "key" })).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/must both be set/)
        );
    });

    it.concurrent("is null without a signing key", () => {
        expect(
            getIssuerConfig({ OIDC_ISSUER: "https://deplodash.euroka.moe" })
        ).toBeNull();
    });

    it.concurrent("derives the JWKS URI from the issuer", () => {
        expect(
            getIssuerConfig({
                OIDC_ISSUER: "https://deplodash.euroka.moe",
                OIDC_SIGNING_KEY: "key",
            })
        ).toEqual({
            issuer: "https://deplodash.euroka.moe",
            jwksUri: "https://deplodash.euroka.moe/.well-known/jwks.json",
            signingKey: "key",
        });
    });
});

describe("buildDiscoveryDocument", () => {
    it.concurrent(
        "advertises RS256, which OIDC Discovery requires and Entra needs",
        () => {
            const doc = buildDiscoveryDocument({
                issuer: "https://deplodash.euroka.moe",
                jwksUri: "https://deplodash.euroka.moe/.well-known/jwks.json",
                signingKey: "SIGNING-KEY-MATERIAL",
            });
            expect(doc.issuer).toBe("https://deplodash.euroka.moe");
            expect(doc.jwks_uri).toBe(
                "https://deplodash.euroka.moe/.well-known/jwks.json"
            );
            expect(doc.id_token_signing_alg_values_supported).toEqual([
                "RS256",
            ]);
            expect(doc.claims_supported).toEqual(
                expect.arrayContaining(["iss", "sub", "aud", "iat", "exp"])
            );
            // The signing key must never appear in a public document.
            expect(JSON.stringify(doc)).not.toContain("SIGNING-KEY-MATERIAL");
        }
    );
});
