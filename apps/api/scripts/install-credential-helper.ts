import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
    closeSync,
    createReadStream,
    createWriteStream,
    openSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const baseUrl =
    process.env.DEPLODASH_INSTALL_URL ??
    "https://raw.githubusercontent.com/concertypin/deplodash/main/apps/api/scripts";
const installDir =
    process.env.DEPLODASH_INSTALL_DIR ??
    join(homedir(), ".local", "share", "deplodash");
const helperPath = join(installDir, "deplodash-credential-helper.ts");
const runnerPath = join(installDir, "deplodash-credential-helper-run.mjs");

function runGit(args: string[]): void {
    const result = spawnSync("git", args, { stdio: "inherit" });
    if (result.status !== 0)
        throw new Error(
            `git config failed with exit code ${result.status ?? "unknown"}`
        );
}

function runGitCapture(args: string[]): {
    status: number | null;
    stdout: string;
} {
    const result = spawnSync("git", args, { encoding: "utf8" });
    return { status: result.status, stdout: String(result.stdout ?? "") };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function promptWithoutEcho(): Promise<string> {
    // POSIX-only no-echo prompt. Falls back to a visible stdin prompt when
    // there is no controlling terminal (e.g. native Windows).
    let ttyFd: number | null = null;
    try {
        ttyFd = openSync("/dev/tty", "r+");
    } catch {
        const fallback = createInterface({
            input: processStdin,
            output: processStdout,
        });
        try {
            const token = await fallback.question(
                "Deplodash agent token (input will be visible): "
            );
            return token.trim();
        } finally {
            fallback.close();
        }
    }

    const input = createReadStream("/dev/tty", { fd: ttyFd, autoClose: false });
    const output = createWriteStream("/dev/tty", {
        fd: ttyFd,
        autoClose: false,
    });
    const prompt = createInterface({ input, output });
    const echo = (enabled: boolean): void => {
        const result = spawnSync("stty", [enabled ? "echo" : "-echo"], {
            stdio: [ttyFd, ttyFd, ttyFd],
        });
        if (result.status !== 0) {
            throw new Error("unable to configure terminal echo");
        }
    };
    let echoDisabled = false;
    const restoreEcho = (): void => {
        if (!echoDisabled) return;
        try {
            echo(true);
        } finally {
            echoDisabled = false;
        }
    };
    const interrupt = (exitCode: number): void => {
        try {
            restoreEcho();
        } finally {
            process.exit(exitCode);
        }
    };
    const onSigint = (): void => interrupt(130);
    const onSigterm = (): void => interrupt(143);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
        echo(false);
        echoDisabled = true;
        const token = await prompt.question("Deplodash agent token: ");
        return token.trim();
    } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        try {
            restoreEcho();
        } finally {
            prompt.close();
            input.destroy();
            output.destroy();
            closeSync(ttyFd);
        }
    }
}

async function readToken(): Promise<string> {
    const configured = process.env.DEPLODASH_AGENT_TOKEN?.trim();
    if (configured) return configured;
    return promptWithoutEcho();
}

async function main(): Promise<void> {
    const token = await readToken();
    if (!token) throw new Error("an agent token is required");

    await mkdir(installDir, { recursive: true });
    process.stdout.write(
        "Downloading the Deplodash Git credential helper...\n"
    );
    const response = await fetch(`${baseUrl}/deplodash-credential-helper.ts`);
    if (!response.ok)
        throw new Error(`helper download failed (HTTP ${response.status})`);
    const helperSource = await response.text();
    // Guard against serving garbage or an unrelated payload: the helper must
    // contain its exported entry point before we persist and execute it.
    if (!helperSource.includes("handleCredentialRequest")) {
        throw new Error("helper download failed verification");
    }
    await writeFile(helperPath, helperSource, { mode: 0o600 });

    const runner = `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\nimport { dirname, join } from "node:path";\nprocess.env.DEPLODASH_AGENT_TOKEN = ${JSON.stringify(token)};\nconst helper = join(dirname(fileURLToPath(import.meta.url)), "deplodash-credential-helper.ts");\nconst result = spawnSync("node", [helper, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });\nprocess.exitCode = result.status ?? 1;\n`;
    const temporaryRunnerPath = `${runnerPath}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryRunnerPath, runner, { mode: 0o700 });
        await chmod(temporaryRunnerPath, 0o700);
        await rename(temporaryRunnerPath, runnerPath);
    } finally {
        await rm(temporaryRunnerPath, { force: true });
    }
    const helperKey = "credential.https://github.com.helper";
    const genericHelperKey = "credential.helper";
    // Preserve existing GitHub-scoped AND generic credential providers
    // (GCM, keychain) as fallback, but move the Deplodash runner ahead of all
    // of them so it is consulted first for github.com. Drop any prior
    // Deplodash entries so reinstalling (e.g. rotating the token) does not
    // stack duplicate helpers that each fire a /api/token request.
    const collectHelpers = (key: string): string[] => {
        const result = runGitCapture(["config", "--global", "--get-all", key]);
        return result.status === 0
            ? result.stdout
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(
                      (line) =>
                          line.length > 0 &&
                          !line.includes("deplodash-credential-helper")
                  )
            : [];
    };
    const retainedHelpers = collectHelpers(helperKey);
    const retainedGenericHelpers = collectHelpers(genericHelperKey);
    const unsetAll = (key: string): void => {
        const result = runGitCapture([
            "config",
            "--global",
            "--unset-all",
            key,
        ]);
        // exit 5 means the key had no values — that is fine.
        if (result.status !== 0 && result.status !== 5) {
            throw new Error(
                `git config failed with exit code ${String(result.status)}`
            );
        }
    };
    unsetAll(helperKey);
    unsetAll(genericHelperKey);
    const configuredRunnerPath = runnerPath.replaceAll("\\", "/");
    runGit([
        "config",
        "--global",
        "--add",
        helperKey,
        `!node ${shellQuote(configuredRunnerPath)}`,
    ]);
    for (const entry of retainedHelpers) {
        runGit(["config", "--global", "--add", helperKey, entry]);
    }
    for (const entry of retainedGenericHelpers) {
        runGit(["config", "--global", "--add", genericHelperKey, entry]);
    }
    process.stdout.write(
        "Installed Deplodash credential helper for HTTPS GitHub remotes.\n"
    );
    process.stdout.write(
        "Run git push normally; approve the consent URL if Git reports that approval is required.\n"
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    void main().catch((error: unknown) => {
        process.stderr.write(
            `${error instanceof Error ? error.message : "installation failed"}\n`
        );
        process.exitCode = 1;
    });
}
