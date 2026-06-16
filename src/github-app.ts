/**
 * GitHub App — JWT signing + Installation Token issuance.
 *
 * Environment variables (via Env bindings):
 *   GITHUB_APP_ID            GitHub App ID (required)
 *   GITHUB_APP_PRIVATE_KEY   PEM-encoded RSA private key (required)
 *   GITHUB_INSTALLATION_ID   Installation ID (required)
 *
 * Uses Web Crypto API (native in Cloudflare Workers) for RS256 JWT signing.
 */

import type { ScopePreset } from "@/types";
import { z } from "zod";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Schema for the GitHub App Installation Token API response.
 * Used for runtime validation instead of type assertions.
 */
const installationTokenResponseSchema = z.object({
    token: z.string(),
    expires_at: z.string(),
    permissions: z.record(z.string(), z.string()),
    repository_selection: z.string(),
});

export interface InstallationToken {
    token: string;
    expires_at: string; // ISO 8601
    permissions: Record<string, string>;
    repositorySelection: string;
}

// ─── Scope Presets ───────────────────────────────────────────────────────────

const SCOPE_PRESETS: Record<ScopePreset, Record<string, string>> = {
    "contents:read": { metadata: "read", contents: "read" },
    "contents:write": { metadata: "read", contents: "write" },
    "contents:write+workflows:write": {
        metadata: "read",
        contents: "write",
        workflows: "write",
    },
    admin: {
        metadata: "read",
        contents: "write",
        workflows: "write",
        administration: "write",
    },
};

/**
 * Convert a scope array to a GitHub permissions object.
 */
export function permissionsFromScopes(
    scopes: string[]
): Record<string, string> {
    const key = [...scopes].sort().join("+") as ScopePreset;
    if (SCOPE_PRESETS[key]) return { ...SCOPE_PRESETS[key] };
    const perms: Record<string, string> = { metadata: "read" };
    for (const s of scopes) {
        if (s === "contents:read") perms.contents = "read";
        else if (s === "contents:write") perms.contents = "write";
        else if (s === "workflows:write") perms.workflows = "write";
        else if (s === "admin") return { ...SCOPE_PRESETS.admin };
    }
    return perms;
}

// ─── PEM → CryptoKey ─────────────────────────────────────────────────────────
/**
 * Parse a PEM-encoded RSA private key and import it as a CryptoKey for RS256 signing.
 *
 * Accepts the following input formats (auto-detected):
 *   1. Raw PEM text — PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`)
 *   2. Base64-encoded PEM — entire PEM file encoded as a single base64 string
 *      (handy for `.dev.vars` / environment variables that don't support multilines)
 *   3. Bare base64 body — no PEM headers/footers, just the raw DER bytes in base64
 *      (assumed PKCS#8; wrap in PEM headers if you have a PKCS#1 bare body)
 *
 * PKCS#1 keys are automatically converted to PKCS#8 in-memory — no openssl needed.
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

type DerResult = { der: Uint8Array<ArrayBuffer>; isPkcs1: boolean };

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

/**
 * Wrap a PKCS#1 RSA private key DER buffer in a PKCS#8 envelope.
 *
 * PKCS#8 unencrypted structure (RFC 5208):
 *   SEQUENCE {
 *     INTEGER 0                          -- version
 *     SEQUENCE { OID rsaEncryption NULL }  -- algorithm
 *     OCTET STRING { <pkcs1Der> }        -- privateKey
 *   }
 *
 * The OID + surrounding structure is always identical for RSA,
 * so we can prepend a fixed header rather than doing full ASN.1 encoding.
 */
function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array<ArrayBuffer> {
    // Fixed ASN.1 prefix for PKCS#8 RSA private key wrapper:
    //   30 xx           SEQUENCE (outer) — length patched below
    //     02 01 00      INTEGER 0 (version)
    //     30 0d         SEQUENCE (algorithmIdentifier)
    //       06 09 ...   OID 1.2.840.113549.1.1.1 (rsaEncryption)
    //       05 00       NULL
    //     04 xx xx      OCTET STRING — length patched below
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
// ─── JWT Helpers ─────────────────────────────────────────────────────────────

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
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

function encodeJSON(obj: Record<string, unknown>): string {
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Sign a JWT using RS256 with the given private key.
 */
async function signJwt(privateKey: CryptoKey, appId: string): Promise<string> {
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

// ─── GitHub App Service ───────────────────────────────────────────────────────

export class GitHubApp {
    private appId: string;
    private installationId: string;
    private keyPromise: Promise<CryptoKey>;

    constructor(appId: string, installationId: string, privateKeyPem: string) {
        this.appId = appId;
        this.installationId = installationId;
        this.keyPromise = pemToCryptoKey(privateKeyPem);
    }

    /**
     * Sign a fresh JWT (10 min expiry).
     * No caching needed — each HTTP request creates a new GitHubApp instance.
     */
    private async getJwt(): Promise<string> {
        const key = await this.keyPromise;
        return signJwt(key, this.appId);
    }

    /**
     * Exchange the App JWT for an Installation Token scoped to the given permissions.
     */
    async getInstallationToken(
        permissions: Record<string, string>
    ): Promise<InstallationToken> {
        const jwt = await this.getJwt();
        const url = `https://api.github.com/app/installations/${this.installationId}/access_tokens`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${jwt}`,
                "User-Agent": "deplodash/1.0",
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ permissions }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(
                `GitHub App token request failed: ${res.status} ${body.slice(0, 500)}`
            );
        }
        const ghResponse = installationTokenResponseSchema.parse(
            await res.json()
        );
        return {
            token: ghResponse.token,
            expires_at: ghResponse.expires_at,
            permissions: ghResponse.permissions,
            repositorySelection: ghResponse.repository_selection,
        };
    }

    /**
     * Request an installation token for a specific set of scope strings.
     * Convenience wrapper around getInstallationToken.
     */
    async requestToken(scopes: string[]): Promise<InstallationToken> {
        const perms = permissionsFromScopes(scopes);
        return this.getInstallationToken(perms);
    }

    /**
     * Ensure a repository exists. If it doesn't, create it using the
     * GitHub App installation's admin permissions.
     *
     * @returns true if the repo already existed or was created successfully.
     */
    async ensureRepoExists(owner: string, repo: string): Promise<boolean> {
        // 1. Get installation token with admin permission
        const adminToken = await this.getInstallationToken({
            administration: "write",
        });

        // 2. Check if repo already exists
        const checkRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
            {
                headers: {
                    Authorization: `Bearer ${adminToken.token}`,
                    "User-Agent": "deplodash/1.0",
                },
            }
        );
        if (checkRes.status === 200) return true;
        if (checkRes.status !== 404) {
            const body = await checkRes.text().catch(() => "");
            throw new Error(
                `Failed to check repo existence: ${checkRes.status} ${body.slice(0, 200)}`
            );
        }

        // 3. Determine if owner is an org or user
        const orgRes = await fetch(`https://api.github.com/orgs/${owner}`, {
            headers: {
                Authorization: `Bearer ${adminToken.token}`,
                "User-Agent": "deplodash/1.0",
            },
        });
        const isOrg = orgRes.status === 200;

        // 4. Create the repo
        const createUrl = isOrg
            ? `https://api.github.com/orgs/${owner}/repos`
            : `https://api.github.com/user/repos`;

        const createRes = await fetch(createUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${adminToken.token}`,
                "User-Agent": "deplodash/1.0",
                "Content-Type": "application/json",
                Accept: "application/vnd.github+json",
            },
            body: JSON.stringify({
                name: repo,
                private: true,
                auto_init: false,
            }),
        });

        if (!createRes.ok) {
            const body = await createRes.text().catch(() => "");
            throw new Error(
                `Failed to create repo ${owner}/${repo}: ${createRes.status} ${body.slice(0, 300)}`
            );
        }

        return true;
    }
}
