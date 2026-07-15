// ─── Crypto Utilities ────────────────────────────────────────────────────────
// Uses Web Crypto API (available natively in Cloudflare Workers).
// Ported from Deno's @std/crypto + @std/encoding/base64.

export const KEY_ID = "k1";
export type CryptoKeyRef = CryptoKey;

// ─── Base64 helpers (no external deps) ───────────────────────────────────────

function base64Encode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
    return base64Encode(bytes)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

// ─── Key derivation (PBKDF2 → AES-256-GCM) ───────────────────────────────────

export async function initKey(secret?: string): Promise<CryptoKeyRef> {
    if (!secret) {
        throw new TypeError(
            "ENCRYPTION_SECRET environment variable is required"
        );
    }
    const salt = new TextEncoder().encode("deploy-key-dashboard-v1");
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );
    return await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

// ─── Encrypt / Decrypt (AES-256-GCM) ─────────────────────────────────────────

export async function encryptWith(
    key: CryptoKeyRef,
    data: string
): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(data);
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoded
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return `${KEY_ID}.${base64Encode(combined)}`;
}

export async function decryptWith(
    key: CryptoKeyRef,
    packet: string
): Promise<string | null> {
    try {
        const dot = packet.indexOf(".");
        if (dot === -1) return null;
        const raw = base64Decode(packet.slice(dot + 1));
        const iv = raw.slice(0, 12);
        const ciphertext = raw.slice(12);
        const decoded = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(decoded);
    } catch {
        return null;
    }
}

// ─── Lazy singleton key cache ────────────────────────────────────────────────
// Derive the AES-GCM key once per isolate and reuse across requests.

let keyPromise: Promise<CryptoKeyRef> | null = null;

export function getOrInitKey(secret: string): Promise<CryptoKeyRef> {
    if (keyPromise) return keyPromise;
    keyPromise = initKey(secret);
    return keyPromise;
}

/** Only needed for testing — resets the cached key so next call re-derives. */
export function resetKeyCache(): void {
    keyPromise = null;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

export function randomBytes(n: number): string {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr);
}

export async function pkceChallenge(verifier: string): Promise<string> {
    const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier)
    );
    return base64UrlEncode(new Uint8Array(hash));
}
