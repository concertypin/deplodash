import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

type CredentialHelperResult = {
    stdout: string;
    stderr: string;
    exitCode: 0 | 1;
};

type CredentialInput = {
    protocol?: string;
    host?: string;
    path?: string;
};

type TokenResponse = {
    status?: unknown;
    token?: unknown;
    url?: unknown;
    consent_url?: unknown;
    effective_scopes?: unknown;
};

const REPOSITORY_PATTERN =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9-._]+$/;
// The production custom domain (`routes` in apps/api/wrangler.jsonc).
const DEFAULT_DEPLODASH_URL = "https://deplodash.euroka.moe";
const REQUEST_TIMEOUT_MS = 15_000;
const REPOSITORY_MODES: Record<string, true> = {
    "existing-only": true,
    "create-if-missing": true,
};

// Mirror of the API's compound presets (apps/api/src/github/scopes.ts):
// overrides must be expanded to granular scopes before both the request and
// the effective-scope comparison.
const COMPOUND_SCOPE_PRESETS: Record<string, string[]> = {
    "contents:write+workflows:write": [
        "metadata:read",
        "contents:write",
        "workflows:write",
    ],
    admin: [
        "metadata:read",
        "contents:write",
        "workflows:write",
        "administration:write",
    ],
};

// Granular scopes the API accepts, mirrored from the Scope union in
// apps/api/src/github/scopes.ts. Overrides containing anything else would
// never be approvable on the consent page, so reject them up front.
const VALID_SCOPES: Record<string, true> = {
    "contents:read": true,
    "contents:write": true,
    "issues:read": true,
    "issues:write": true,
    "pulls:read": true,
    "pulls:write": true,
    "actions:read": true,
    "actions:write": true,
    "metadata:read": true,
    "deployments:read": true,
    "deployments:write": true,
    "administration:read": true,
    "administration:write": true,
    "members:read": true,
    "members:write": true,
    "secrets:read": true,
    "secrets:write": true,
    "pages:read": true,
    "pages:write": true,
    "webhooks:read": true,
    "webhooks:write": true,
    "environments:read": true,
    "environments:write": true,
    "variables:read": true,
    "variables:write": true,
    "workflows:write": true,
    "checks:read": true,
    "checks:write": true,
};

function expandConfiguredScopes(scopes: string[]): string[] {
    const result = new Set<string>();
    for (const scope of scopes) {
        const preset = COMPOUND_SCOPE_PRESETS[scope];
        const parts = preset ?? [scope];
        for (const part of parts) result.add(part);
    }
    return [...result];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseCredentialInput(input: string): CredentialInput {
    const fields: CredentialInput = {};
    for (const line of input.split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === "protocol" || key === "host" || key === "path") {
            fields[key] = value;
        }
    }
    return fields;
}

function parseRepository(path: string | undefined): string | null {
    if (!path) return null;
    // Git LFS asks for credentials at <repo>.git/info/lfs/... — drop the LFS
    // suffix before matching the repository portion.
    const repository = path
        .replace(/\/info\/lfs.*$/, "")
        .replace(/^\//, "")
        .replace(/\.git$/, "");
    return REPOSITORY_PATTERN.test(repository) ? repository : null;
}

function parseScopes(value: string): string[] {
    return value
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);
}

function missingEffectiveScopes(
    requested: string[],
    payload: TokenResponse
): string[] {
    if (!Array.isArray(payload.effective_scopes)) return [];
    const effective = new Set(
        payload.effective_scopes.filter(
            (scope): scope is string => typeof scope === "string"
        )
    );
    return requested.filter((scope) => !effective.has(scope));
}

function failure(message: string): CredentialHelperResult {
    // Never quit: an empty stdout lets Git fall through to the user's other
    // credential helpers (GCM, keychain) for repositories that are not
    // managed by Deplodash, while the diagnostic below tells deplodash users
    // what to do next.
    return {
        stdout: "",
        stderr: `${message}\n`,
        exitCode: 0,
    };
}

function ignored(): CredentialHelperResult {
    return { stdout: "", stderr: "", exitCode: 0 };
}

function redactedError(error: unknown): string {
    return error instanceof Error
        ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        : "request failed";
}

async function handleCredentialRequest(
    action: string | undefined,
    input: string,
    env: Readonly<NodeJS.ProcessEnv>,
    dependencies: { fetch: typeof globalThis.fetch }
): Promise<CredentialHelperResult> {
    if (action !== "get") return ignored();

    const credential = parseCredentialInput(input);
    // Git may append the explicit default HTTPS port to the host.
    const host =
        credential.host?.toLowerCase().replace(/^([^:]+):443$/, "$1") ?? "";
    if (credential.protocol !== "https" || host !== "github.com")
        return ignored();

    const repo = parseRepository(credential.path);
    if (!repo) return ignored();

    // Unconfigured helper: stay silent so Git falls through to the user's
    // other credential providers.
    const agentToken = env.DEPLODASH_AGENT_TOKEN?.trim();
    if (!agentToken) return ignored();

    // Git does not pass the pushed ref to credential helpers. Request the
    // workflow permission conservatively unless the caller supplies an
    // explicit scope override.
    let scopes = ["contents:write", "workflows:write"];
    if (env.DEPLODASH_SCOPES !== undefined) {
        const parsedScopes = parseScopes(env.DEPLODASH_SCOPES);
        if (parsedScopes.length === 0) {
            return failure("DEPLODASH_SCOPES must contain at least one scope");
        }
        scopes = expandConfiguredScopes(parsedScopes);
        const invalidScopes = scopes.filter((scope) => !VALID_SCOPES[scope]);
        if (invalidScopes.length > 0) {
            return failure(
                `DEPLODASH_SCOPES contains unsupported scopes: ${invalidScopes.join(", ")}`
            );
        }
    }

    const configuredRepoMode = env.DEPLODASH_REPO_MODE?.trim();
    if (configuredRepoMode && !REPOSITORY_MODES[configuredRepoMode]) {
        return failure(
            'DEPLODASH_REPO_MODE must be "existing-only" or "create-if-missing"'
        );
    }

    const baseUrl = (
        env.DEPLODASH_URL?.trim() || DEFAULT_DEPLODASH_URL
    ).replace(/\/+$/, "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await dependencies.fetch(`${baseUrl}/api/token`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${agentToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(
                configuredRepoMode
                    ? { repo, scopes, repo_mode: configuredRepoMode }
                    : { repo, scopes }
            ),
            signal: controller.signal,
        });

        let payload: TokenResponse = {};
        try {
            const parsed: unknown = await response.json();
            if (isRecord(parsed)) payload = parsed satisfies TokenResponse;
        } catch {
            return failure(
                `token request returned invalid JSON (HTTP ${response.status})`
            );
        }

        if (
            response.status === 200 &&
            typeof payload.token === "string" &&
            payload.token.length > 0
        ) {
            // The API may return a token whose effective scopes are a subset
            // of the requested scopes (partial consent). Handing that token
            // to Git produces a confusing push-time 403, so fail fast with a
            // consent directive. When the API includes a consent URL for the
            // missing scopes, surface it so the user can approve directly.
            const missingScopes = missingEffectiveScopes(scopes, payload);
            if (missingScopes.length > 0) {
                const consentUrl =
                    typeof payload.consent_url === "string"
                        ? payload.consent_url
                        : null;
                return failure(
                    consentUrl
                        ? `consent required: ${consentUrl}`
                        : `token scopes are narrower than requested (missing: ${missingScopes.join(", ")}); grant consent for these scopes and retry`
                );
            }
            return {
                stdout: `username=x-access-token\npassword=${payload.token}\n\n`,
                stderr: "",
                exitCode: 0,
            };
        }
        if (response.status === 202 && typeof payload.url === "string") {
            return failure(`consent required: ${payload.url}`);
        }
        return failure(`token request failed (HTTP ${response.status})`);
    } catch (error: unknown) {
        return failure(`token request failed: ${redactedError(error)}`);
    } finally {
        clearTimeout(timer);
    }
}

async function main(): Promise<void> {
    const input = await new Promise<string>((resolve, reject) => {
        let value = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => (value += chunk));
        process.stdin.on("end", () => resolve(value));
        process.stdin.on("error", reject);
    });
    const result = await handleCredentialRequest(
        process.argv[2],
        input,
        process.env,
        { fetch: globalThis.fetch }
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
}

// Node resolves symlinks in the main module's URL, so compare real paths:
// the script may be launched through a symlinked directory (e.g. macOS's
// /var -> /private/var temp directory).
function isEntryPoint(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(entry)).href;
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    void main();
}

export type { CredentialHelperResult };
export { COMPOUND_SCOPE_PRESETS, VALID_SCOPES, handleCredentialRequest };
