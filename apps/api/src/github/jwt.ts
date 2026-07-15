/**
 * JWT signing utilities for GitHub App authentication.
 *
 * Signs RS256 JWTs using Web Crypto API (native in Cloudflare Workers).
 * The JWT is used to authenticate as a GitHub App when requesting
 * installation tokens.
 */

// ─── Base64 URL encoding ─────────────────────────────────────────────────────

/**
 * Encode binary data as a base64url string (no padding).
 * Used for JWT header, payload, and signature encoding.
 */
export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

// ─── JWT encoding ────────────────────────────────────────────────────────────

function encodeJSON(obj: Record<string, unknown>): string {
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Sign a JWT using RS256 with the given private key.
 *
 * @param privateKey - CryptoKey for RS256 signing (from PEM).
 * @param appId - GitHub App ID.
 * @returns A signed JWT string (header.payload.signature).
 */
export async function signJwt(
    privateKey: CryptoKey,
    appId: string
): Promise<string> {
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iat: now,
        exp: now + 600, // 10 minutes
        iss: appId,
    };
    const headerB64 = encodeJSON(header);
    const payloadB64 = encodeJSON(payload);
    const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        privateKey,
        message
    );
    return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}
