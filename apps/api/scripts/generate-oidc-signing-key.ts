// Generates the RS256 signing key for Deplodash's OIDC issuer.
//
//   node scripts/generate-oidc-signing-key.ts | pnpm exec wrangler secret put OIDC_SIGNING_KEY
//
// stdout: the private key as PKCS#8 PEM — nothing else, so it can be piped.
// Hints go to stderr. The `kid` is not printed: it is the RFC 7638 thumbprint
// and shows up in /.well-known/jwks.json once deployed.
//
//   node scripts/generate-oidc-signing-key.ts --public < key.pem
//
// stdout: the public JWK (`{"kty","n","e"}`) of a PKCS#8 PEM read from
// stdin, for `OIDC_ADDITIONAL_JWKS` during key rotation.

import { webcrypto } from "node:crypto";

const RS256 = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
} as const;

async function printPublicJwk(): Promise<void> {
    process.stdin.setEncoding("utf8");
    let pem = "";
    for await (const chunk of process.stdin) pem += String(chunk);
    const body = pem
        .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
        .replace(/\s/g, "");
    if (!body) {
        throw new Error("Expected a PKCS#8 PEM (BEGIN PRIVATE KEY) on stdin");
    }
    const key = await webcrypto.subtle.importKey(
        "pkcs8",
        Buffer.from(body, "base64"),
        RS256,
        true,
        ["sign"]
    );
    const { n, e } = await webcrypto.subtle.exportKey("jwk", key);
    process.stdout.write(`${JSON.stringify({ kty: "RSA", n, e })}\n`);
}

async function printNewPrivateKey(): Promise<void> {
    const keyPair = await webcrypto.subtle.generateKey(
        {
            ...RS256,
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
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
}

await (process.argv.includes("--public")
    ? printPublicJwk()
    : printNewPrivateKey());
