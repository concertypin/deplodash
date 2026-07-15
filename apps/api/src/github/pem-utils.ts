/**
 * PEM key parsing utilities for GitHub App JWT signing.
 *
 * Accepts the following input formats (auto-detected):
 *   1. Raw PEM text — PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`)
 *   2. Base64-encoded PEM — entire PEM file encoded as a single base64 string
 *      (handy for environment variables that don't support multilines)
 *   3. Bare base64 body — no PEM headers/footers, just the raw DER bytes in base64
 *      (assumed PKCS#8; wrap in PEM headers if you have a PKCS#1 bare body)
 *
 * PKCS#1 keys are automatically converted to PKCS#8 in-memory — no openssl needed.
 */

type DerResult = { der: Uint8Array<ArrayBuffer>; isPkcs1: boolean };

/**
 * Parse a PEM-encoded RSA private key and import it as a CryptoKey for RS256 signing.
 */
export async function pemToCryptoKey(pem: string): Promise<CryptoKey> {
    const { der, isPkcs1 } = extractDer(pem.trim());

    const pkcs8Der = isPkcs1 ? pkcs1ToPkcs8(der) : der;
    return crypto.subtle.importKey(
        "pkcs8",
        pkcs8Der,
        { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
        false,
        ["sign"]
    );
}

/**
 * Extract raw DER bytes and key format from any supported input.
 */
function extractDer(input: string): DerResult {
    // Case 1: raw PEM text
    if (input.startsWith("-----BEGIN")) {
        return parsePem(input);
    }

    // Case 2: base64-encoded PEM (entire file as one env var)
    const decoded = tryBase64Decode(input);
    if (decoded !== null && decoded.startsWith("-----BEGIN")) {
        return parsePem(decoded);
    }

    // Case 3: bare base64 DER body (assumed PKCS#8)
    if (/^[A-Za-z0-9+/=\s]+$/.test(input)) {
        return { der: base64ToDer(input.replace(/\s/g, "")), isPkcs1: false };
    }

    throw new Error(
        "Unrecognised key format. Expected: PEM text, base64-encoded PEM, or bare base64 DER body."
    );
}

/**
 * Parse a PEM string and return its DER bytes + format flag.
 * Handles both PKCS#8 (`BEGIN PRIVATE KEY`) and PKCS#1 (`BEGIN RSA PRIVATE KEY`).
 */
function parsePem(pem: string): DerResult {
    const lines = pem.split(/\r?\n/);
    const header = lines.find((l) => l.startsWith("-----BEGIN")) ?? "";
    const isPkcs1 = header.includes("RSA PRIVATE KEY");

    const bodyLines = lines.filter(
        (line) =>
            !line.startsWith("-----") &&
            !line.includes(":") && // inline attrs: Proc-Type, DEK-Info, …
            line.trim() !== ""
    );

    if (bodyLines.length === 0) {
        throw new Error(
            "PEM body is empty — the key may be encrypted or malformed."
        );
    }

    return { der: base64ToDer(bodyLines.join("")), isPkcs1 };
}

// ─── PKCS#1 → PKCS#8 conversion ─────────────────────────────────────────────

/**
 * Wrap a PKCS#1 RSA private key DER buffer in a PKCS#8 envelope.
 *
 * PKCS#8 unencrypted structure (RFC 5208):
 *   SEQUENCE {
 *     INTEGER 0                          -- version
 *     SEQUENCE { OID rsaEncryption NULL }  -- algorithm
 *     OCTET STRING { <pkcs1Der> }        -- privateKey
 *   }
 */
function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array<ArrayBuffer> {
    const oidAndAlg = new Uint8Array([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
        0x01, 0x05, 0x00,
    ]);
    const version = new Uint8Array([0x02, 0x01, 0x00]);

    const octetStringHeader = encodeAsn1Length(0x04, pkcs1Der.length);
    const innerLen =
        version.length +
        oidAndAlg.length +
        octetStringHeader.length +
        pkcs1Der.length;
    const outerHeader = encodeAsn1Length(0x30, innerLen);

    const out = new Uint8Array(
        outerHeader.length +
            version.length +
            oidAndAlg.length +
            octetStringHeader.length +
            pkcs1Der.length
    );
    let offset = 0;
    for (const chunk of [
        outerHeader,
        version,
        oidAndAlg,
        octetStringHeader,
        pkcs1Der,
    ]) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

// ─── ASN.1 encoding helpers ─────────────────────────────────────────────────

/**
 * Encode an ASN.1 tag + DER length prefix.
 * Handles short form (< 128) and long form (multi-byte length).
 */
function encodeAsn1Length(tag: number, length: number): Uint8Array {
    if (length < 0x80) {
        return new Uint8Array([tag, length]);
    }
    if (length < 0x100) {
        return new Uint8Array([tag, 0x81, length]);
    }
    return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
}

// ─── Base64 helpers ─────────────────────────────────────────────────────────

function tryBase64Decode(input: string): string | null {
    try {
        return atob(input.replace(/\s/g, ""));
    } catch {
        return null;
    }
}

function base64ToDer(base64: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
