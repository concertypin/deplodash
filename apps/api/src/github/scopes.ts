/**
 * Scope definitions & helpers for GitHub App Installation Tokens.
 *
 * Maps Deplodash scopes to GitHub API permission names/levels,
 * provides human-readable labels, and converts scope arrays to
 * GitHub permissions objects.
 */

// ─── Scope → GitHub permission mapping ──────────────────────────────────────

/**
 * Map each Deplodash scope to its [GitHub permission name, permission level].
 */
const SCOPE_TO_GITHUB: Record<string, [string, string]> = {
    "contents:read": ["contents", "read"],
    "contents:write": ["contents", "write"],
    "issues:read": ["issues", "read"],
    "issues:write": ["issues", "write"],
    "pulls:read": ["pull_requests", "read"],
    "pulls:write": ["pull_requests", "write"],
    "actions:read": ["actions", "read"],
    "actions:write": ["actions", "write"],
    "metadata:read": ["metadata", "read"],
    "deployments:read": ["deployments", "read"],
    "deployments:write": ["deployments", "write"],
    "administration:read": ["administration", "read"],
    "administration:write": ["administration", "write"],
    "members:read": ["members", "read"],
    "members:write": ["members", "write"],
    "secrets:read": ["secrets", "read"],
    "secrets:write": ["secrets", "write"],
    "pages:read": ["pages", "read"],
    "pages:write": ["pages", "write"],
    "webhooks:read": ["webhooks", "read"],
    "webhooks:write": ["webhooks", "write"],
    "environments:read": ["environments", "read"],
    "environments:write": ["environments", "write"],
    "variables:read": ["variables", "read"],
    "variables:write": ["variables", "write"],
    "workflows:write": ["workflows", "write"],
    "checks:read": ["checks", "read"],
    "checks:write": ["checks", "write"],
};

/**
 * Legacy preset combinations — shortcut for common patterns.
 */
const LEGACY_PRESETS: Record<string, Record<string, string>> = {
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

// ─── Scope labels & UI categories ────────────────────────────────────────────

/**
 * Human-readable labels for each scope.
 */
export const SCOPE_LABELS: Record<string, string> = {
    "contents:read": "Read repository contents",
    "contents:write": "Read & write repository contents",
    "issues:read": "Read issues",
    "issues:write": "Read & write issues",
    "pulls:read": "Read pull requests",
    "pulls:write": "Read & write pull requests",
    "actions:read": "View Actions workflows & runs",
    "actions:write": "Manage Actions workflows & runs",
    "metadata:read": "Read repository metadata",
    "deployments:read": "View deployments",
    "deployments:write": "Manage deployments",
    "administration:read": "View repository settings",
    "administration:write": "Manage repository settings (rename, delete)",
    "members:read": "View collaborators",
    "members:write": "Manage collaborators",
    "secrets:read": "View repository secrets & variables",
    "secrets:write": "Manage repository secrets & variables",
    "pages:read": "View GitHub Pages settings",
    "pages:write": "Manage GitHub Pages settings & builds",
    "webhooks:read": "View webhooks",
    "webhooks:write": "Manage webhooks",
    "environments:read": "View environments",
    "environments:write": "Manage environments",
    "variables:read": "View Actions variables",
    "variables:write": "Manage Actions variables",
    "workflows:write": "Manage workflow files",
    "checks:read": "View check runs & suites",
    "checks:write": "Create & update check runs",
};

/**
 * Compound/builtin scopes that are not individual permission scopes
 * but rather preset combinations of multiple scopes.
 */
export const COMPOUND_SCOPES = new Set([
    "admin",
    "contents:write+workflows:write",
]);

/**
 * Scope categories for UI grouping.
 * Keyed by category ID.
 */
export const SCOPE_CATEGORIES: Record<
    string,
    { label: string; scopes: string[] }
> = {
    contents: {
        label: "📂 Repository Contents",
        scopes: ["contents:read", "contents:write", "workflows:write"],
    },
    issues: {
        label: "🔀 Issues",
        scopes: ["issues:read", "issues:write"],
    },
    pulls: {
        label: "🔁 Pull Requests",
        scopes: ["pulls:read", "pulls:write"],
    },
    actions: {
        label: "✅ Actions & CI",
        scopes: [
            "actions:read",
            "actions:write",
            "checks:read",
            "checks:write",
            "variables:read",
            "variables:write",
        ],
    },
    metadata: {
        label: "📋 Metadata",
        scopes: ["metadata:read", "deployments:read", "deployments:write"],
    },
    administration: {
        label: "🔐 Administration",
        scopes: ["administration:read", "administration:write"],
    },
    security: {
        label: "🛡️ Security & Access",
        scopes: [
            "secrets:read",
            "secrets:write",
            "members:read",
            "members:write",
        ],
    },
    pages: {
        label: "🌐 Pages & Webhooks",
        scopes: [
            "pages:read",
            "pages:write",
            "webhooks:read",
            "webhooks:write",
        ],
    },
    environments: {
        label: "🗂️ Environments",
        scopes: ["environments:read", "environments:write"],
    },
};

/**
 * All supported scopes for GitHub App Installation Tokens.
 */
export type Scope =
    | "contents:read"
    | "contents:write"
    | "issues:read"
    | "issues:write"
    | "pulls:read"
    | "pulls:write"
    | "actions:read"
    | "actions:write"
    | "metadata:read"
    | "deployments:read"
    | "deployments:write"
    | "administration:read"
    | "administration:write"
    | "members:read"
    | "members:write"
    | "secrets:read"
    | "secrets:write"
    | "pages:read"
    | "pages:write"
    | "webhooks:read"
    | "webhooks:write"
    | "environments:read"
    | "environments:write"
    | "variables:read"
    | "variables:write"
    | "workflows:write"
    | "checks:read"
    | "checks:write";

/**
 * Scope presets for GitHub App Installation Tokens.
 */
export type ScopePreset =
    | "contents:read"
    | "contents:write"
    | "contents:write+workflows:write"
    | "admin";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert a scope array to a GitHub permissions object.
 *
 * Each scope in the array is mapped to its corresponding GitHub permission.
 * @param scopes — list of scope strings (e.g. ["contents:read", "issues:write"])
 * @returns a GitHub permissions object (e.g. { metadata: "read", contents: "read", issues: "write" })
 */
export function permissionsFromScopes(
    scopes: string[]
): Record<string, string> {
    const sorted = [...scopes].sort().join("+");

    // Check legacy presets first for backward compat
    if (sorted in LEGACY_PRESETS) {
        return { ...LEGACY_PRESETS[sorted] };
    }

    // Check for literal "admin" in the array
    if (scopes.includes("admin")) {
        return { ...LEGACY_PRESETS.admin };
    }

    // Build permissions from individual scope mappings
    const perms: Record<string, string> = {};
    for (const s of scopes) {
        const mapping = SCOPE_TO_GITHUB[s];
        if (mapping) {
            const [permName, permLevel] = mapping;
            // Upgrade level: write >= read. Don't downgrade if already higher.
            const existing = perms[permName];
            if (!existing || (existing === "read" && permLevel === "write")) {
                perms[permName] = permLevel;
            }
        }
    }

    // Always include metadata:read as base permission
    if (!perms.metadata) {
        perms.metadata = "read";
    }

    return perms;
}

/**
 * Hash a scope array for use as a KV key.
 * Returns a 16-char base64url-encoded SHA-256 digest of the sorted, joined scopes.
 */
export async function hashScopes(scopes: string[]): Promise<string> {
    const sorted = [...scopes].sort().join(",");
    const utf8 = new TextEncoder().encode(sorted);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8));
    return btoa(String.fromCharCode(...hash))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
        .slice(0, 16);
}
