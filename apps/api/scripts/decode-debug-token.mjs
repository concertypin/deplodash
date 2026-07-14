// Decode a K1 debug token from the OAuth error message.
// Usage: node scripts/decode-debug-token.mjs <token>
// Uses global Web Crypto API — no imports needed (Node 19+).

const token = process.argv[2];
if (!token) {
    console.error("Usage: node scripts/decode-debug-token.mjs <token>");
    process.exit(1);
}

const secret = process.env.ENCRYPTION_SECRET ?? "dev-secret-key-1234567890123456";

// ── Key derivation (matches apps/api/src/crypto.ts) ────────────────────────
const salt = new TextEncoder().encode("deploy-key-dashboard-v1");
const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
);
const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
);

// ── Parse token (k1.base64(iv + ciphertext)) ───────────────────────────────
const dot = token.indexOf(".");
if (dot === -1) throw new Error("Invalid token format — missing dot separator");
const raw = Uint8Array.from(atob(token.slice(dot + 1)), (c) => c.charCodeAt(0));
const iv = raw.slice(0, 12);
const ciphertext = raw.slice(12);

try {
    const decoded = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
    );
    console.log("✅ Decrypted:", new TextDecoder().decode(decoded));
} catch {
    console.error("❌ Decryption failed — wrong secret or corrupted token.");
}
