// Generates the RS256 signing key for Deplodash's OIDC issuer.
//
//   node scripts/generate-oidc-signing-key.ts | pnpm exec wrangler secret put OIDC_SIGNING_KEY
//
// stdout: the private key as PKCS#8 PEM — nothing else, so it can be piped.
// Hints go to stderr. The `kid` is not printed: it is the RFC 7638 thumbprint
// and shows up in /.well-known/jwks.json once deployed.

import { webcrypto } from "node:crypto";

const keyPair = await webcrypto.subtle.generateKey(
    {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
);
const pkcs8 = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey)
).toString("base64");
const body = pkcs8.match(/.{1,64}/g)!.join("\n");

process.stdout.write(
    `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
);
process.stderr.write(
    "Private key written to stdout. Store it as the OIDC_SIGNING_KEY secret; do not commit it.\n"
);
