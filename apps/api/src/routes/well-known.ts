/**
 * Well-known routes — OIDC discovery document and JWKS.
 *
 * Public (no session): mounted ahead of the session middleware in
 * `route.ts`. They must be registered explicitly: `app.notFound` would
 * otherwise hand unknown GET paths to the SPA assets binding.
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import {
    JWKS_PATH,
    OPENID_CONFIGURATION_PATH,
    buildDiscoveryDocument,
    buildJwks,
    getIssuerConfig,
} from "@/oidc/issuer";
import { getOidcSigner } from "@/oidc/signer";

const CACHE_CONTROL = "public, max-age=300";
const MISCONFIGURED = { error: "OIDC signing keys are misconfigured" };

export const wellKnownRouter = new Hono<HonoEnv>()
    .get(OPENID_CONFIGURATION_PATH, async (c) => {
        const config = getIssuerConfig(c.env);
        if (!config) return c.text("Not Found", 404);
        try {
            // Fail here too, so a WIF provider is never created against an
            // issuer whose JWKS cannot be served.
            await getOidcSigner(config.signingKey);
        } catch (err: unknown) {
            console.error("well-known: invalid OIDC signing key", err);
            return c.json(MISCONFIGURED, 503);
        }
        return c.json(buildDiscoveryDocument(config), 200, {
            "Cache-Control": CACHE_CONTROL,
        });
    })
    .get(JWKS_PATH, async (c) => {
        const config = getIssuerConfig(c.env);
        if (!config) return c.text("Not Found", 404);
        try {
            return c.json(
                await buildJwks(config, c.env.OIDC_ADDITIONAL_JWKS),
                200,
                { "Cache-Control": CACHE_CONTROL }
            );
        } catch (err: unknown) {
            // Misconfigured key material: messages never contain key bytes.
            console.error("well-known: failed to build JWKS", err);
            return c.json(MISCONFIGURED, 503);
        }
    });
