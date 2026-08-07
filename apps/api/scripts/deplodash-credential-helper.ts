import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type CredentialHelperResult = {
    stdout: string;
    stderr: string;
    exitCode: 0 | 1;
};

type GitResult = {
    success: boolean;
    stdout: string;
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
};

const REPOSITORY_PATTERN =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9-._]+$/;
const DEFAULT_DEPLODASH_URL = "https://deplodash.condev.workers.dev";
const REQUEST_TIMEOUT_MS = 15_000;

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
    const repository = path.replace(/^\//, "").replace(/\.git$/, "");
    return REPOSITORY_PATTERN.test(repository) ? repository : null;
}

function parseScopes(value: string | undefined): string[] | null {
    if (value === undefined) return null;
    const scopes = value
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);
    return scopes.length > 0 ? scopes : [];
}

function failure(message: string): CredentialHelperResult {
    return {
        stdout: "quit=1\n\n",
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

async function resolveScopes(
    configuredScopes: string | undefined,
    runGit: (args: string[]) => GitResult
): Promise<string[]> {
    const override = parseScopes(configuredScopes);
    if (override !== null) return override;

    // Git does not pass the pushed ref to credential helpers. Request the
    // workflow permission conservatively unless the caller supplies an
    // explicit scope override.
    void runGit;
    return ["contents:write", "workflows:write"];
}

async function handleCredentialRequest(
    action: string | undefined,
    input: string,
    env: Readonly<NodeJS.ProcessEnv>,
    dependencies: {
        fetch: typeof globalThis.fetch;
        runGit: (args: string[]) => GitResult;
    }
): Promise<CredentialHelperResult> {
    if (action !== "get") return ignored();

    const credential = parseCredentialInput(input);
    if (
        credential.protocol !== "https" ||
        credential.host?.toLowerCase() !== "github.com"
    )
        return ignored();

    const repo = parseRepository(credential.path);
    if (!repo) return ignored();

    const agentToken = env.DEPLODASH_AGENT_TOKEN?.trim();
    if (!agentToken) return failure("DEPLODASH_AGENT_TOKEN is required");

    const configuredScopes = env.DEPLODASH_SCOPES;
    if (
        configuredScopes !== undefined &&
        parseScopes(configuredScopes)?.length === 0
    ) {
        return failure("DEPLODASH_SCOPES must contain at least one scope");
    }

    const baseUrl = (
        env.DEPLODASH_URL?.trim() || DEFAULT_DEPLODASH_URL
    ).replace(/\/+$/, "");
    let scopes: string[];
    try {
        scopes = await resolveScopes(configuredScopes, dependencies.runGit);
    } catch (error: unknown) {
        return failure(`scope detection failed: ${redactedError(error)}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await dependencies.fetch(`${baseUrl}/api/token`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${agentToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ repo, scopes }),
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
        {
            fetch: globalThis.fetch,
            runGit: (args) => {
                const gitProcess = spawnSync("git", args, { encoding: "utf8" });
                return {
                    success: gitProcess.status === 0,
                    stdout: String(gitProcess.stdout ?? ""),
                };
            },
        }
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    void main();
}

export type { CredentialHelperResult, GitResult };
export { handleCredentialRequest };
