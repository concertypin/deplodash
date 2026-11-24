import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";

const scriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "generate-oidc-signing-key.ts"
);

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

function runScript(args: string[], input?: string) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
        input,
        encoding: "utf8",
    });
    return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}

/** DER bytes of a PKCS#8 PEM, copied into an ArrayBuffer-backed view for WebCrypto. */
function pemBody(pem: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
        Buffer.from(
            pem
                .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
                .replace(/\s/g, ""),
            "base64"
        )
    );
}

void test("prints only a 2048-bit PKCS#8 PEM on stdout, hints on stderr", async () => {
    const { status, stdout, stderr } = runScript([]);
    assert.equal(status, 0);
    assert.match(
        stdout,
        /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/
    );
    assert.match(stderr, /do not commit it/);

    const key = await webcrypto.subtle.importKey(
        "pkcs8",
        pemBody(stdout),
        RS256,
        true,
        ["sign"]
    );
    const { n } = await webcrypto.subtle.exportKey("jwk", key);
    assert.ok(n);
    assert.equal(Buffer.from(n, "base64url").length * 8, 2048);
});

void test("--public prints the public JWK of the PEM on stdin", async () => {
    const pem = runScript([]).stdout;
    const { status, stdout } = runScript(["--public"], pem);
    assert.equal(status, 0);

    // Strict: exactly the public members, no d, p, q, dp, dq or qi.
    const jwk = z
        .strictObject({ kty: z.literal("RSA"), n: z.string(), e: z.string() })
        .parse(JSON.parse(stdout));

    // The printed key verifies a signature made with the private key.
    const privateKey = await webcrypto.subtle.importKey(
        "pkcs8",
        pemBody(pem),
        RS256,
        false,
        ["sign"]
    );
    const publicKey = await webcrypto.subtle.importKey(
        "jwk",
        jwk,
        RS256,
        false,
        ["verify"]
    );
    const data = new TextEncoder().encode("rotation check");
    const signature = await webcrypto.subtle.sign(RS256, privateKey, data);
    assert.equal(
        await webcrypto.subtle.verify(RS256, publicKey, signature, data),
        true
    );
});

void test("--public fails without a PEM on stdin", () => {
    const { status, stdout } = runScript(["--public"], "");
    assert.notEqual(status, 0);
    assert.equal(stdout, "");
});
