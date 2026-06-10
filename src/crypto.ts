import { encodeBase64, decodeBase64 } from "jsr:@std/encoding/base64";

// ─── Crypto ──────────────────────────────────────────────────────────────────

export const KEY_ID = "k1";
export type CryptoKeyRef = CryptoKey;

export async function initKey(secret?: string): Promise<CryptoKeyRef> {
  if (!secret) {
    throw new TypeError("SECRET environment variable is required — set it or pass --secret");
  }
  const salt = new TextEncoder().encode("deploy-key-dashboard-v1");
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits", "deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptWith(key: CryptoKeyRef, data: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return KEY_ID + "." + encodeBase64(combined);
}

export async function decryptWith(key: CryptoKeyRef, packet: string): Promise<string | null> {
  try {
    const dot = packet.indexOf(".");
    if (dot === -1) return null;
    const raw = decodeBase64(packet.slice(dot + 1));
    const iv = raw.slice(0, 12);
    const ciphertext = raw.slice(12);
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decoded);
  } catch {
    return null;
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBytes(n: number): string {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
}
