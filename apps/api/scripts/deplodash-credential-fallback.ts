/**
 * Wraps one fallback Git credential helper behind the Deplodash runner.
 *
 * Git's approve phase sends `store` to every configured helper, so without
 * this wrapper a persistent provider (GCM, osxkeychain, credential-store)
 * would save the short-lived installation token Deplodash issued and later
 * return it after it expired. The wrapper forwards every action to the
 * original helper through Git itself, so the helper runs exactly as Git
 * would run it, but never hands it a GitHub App installation token.
 *
 * Usage (as a Git credential helper): `!node <this file> <original helper>`.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type GitRun = (
    args: string[],
    input: string,
    onStderrLine: (line: string) => void
) => Promise<{ status: number | null; stdout: string }>;

const GIT_ACTIONS: Record<string, "fill" | "approve" | "reject"> = {
    get: "fill",
    store: "approve",
    erase: "reject",
};

// Ends the inner `git credential fill` when the wrapped helper has nothing,
// so Git does not prompt on its own; the outer Git still prompts if no
// helper in its chain answers. A shell function, because Git appends the
// action ("get") to `!` helpers and `quit=1 get` is not a boolean.
const QUIT_HELPER = "!f() { echo quit=1; }; f";

/** GitHub App installation tokens are short-lived and never worth keeping. */
function isInstallationToken(input: string): boolean {
    return input
        .split(/\r?\n/)
        .some((line) => line.startsWith("password=ghs_"));
}

function spawnGitCredential(
    args: string[],
    input: string,
    onStderrLine: (line: string) => void
): ReturnType<GitRun> {
    const { promise, resolve } = Promise.withResolvers<{
        status: number | null;
        stdout: string;
    }>();
    const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    // Streamed line by line, so a helper's instructions (e.g. a device-code
    // prompt) reach the user while it is still waiting.
    createInterface({ input: child.stderr }).on("line", onStderrLine);
    child.on("error", (error) => {
        onStderrLine(error.message);
        resolve({ status: null, stdout: "" });
    });
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(input);
    return promise;
}

/** Forward one credential action to `helper`; resolves to its stdout. */
async function runFallback(
    helper: string | undefined,
    action: string | undefined,
    input: string,
    writeStderr: (text: string) => void,
    runGit: GitRun = spawnGitCredential
): Promise<string> {
    const gitAction = action === undefined ? undefined : GIT_ACTIONS[action];
    if (!helper || !gitAction) return "";
    // Never store an installation token, and never erase by one: the
    // provider did not store it, and a host-only match could drop the
    // user's own credential.
    if (gitAction !== "fill" && isInstallationToken(input)) return "";

    // The empty value resets every helper configured before it, so only the
    // wrapped helper (plus the quit guard for `get`) runs.
    const args = [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
    ];
    if (gitAction === "fill")
        args.push("-c", `credential.helper=${QUIT_HELPER}`);
    args.push("credential", gitAction);
    const result = await runGit(args, input, (line) => {
        // Git's "told us to quit" message quotes the guard in any locale.
        if (!line.includes(QUIT_HELPER)) writeStderr(`${line}\n`);
    });
    // A helper that has nothing returns nothing; Git moves to the next one.
    return result.status === 0 ? result.stdout : "";
}

async function main(): Promise<void> {
    const input = await new Promise<string>((resolve, reject) => {
        let value = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => (value += chunk));
        process.stdin.on("end", () => resolve(value));
        process.stdin.on("error", reject);
    });
    const stdout = await runFallback(
        process.argv[2],
        process.argv[3],
        input,
        (text) => process.stderr.write(text)
    );
    process.stdout.write(stdout);
}

// Node resolves symlinks in the main module's URL, so compare real paths:
// Git may launch this through a symlinked install directory.
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

export type { GitRun };
export { QUIT_HELPER, isInstallationToken, runFallback };
