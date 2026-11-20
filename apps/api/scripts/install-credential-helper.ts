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
import { homedir, tmpdir } from "node:os";
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

type GitResult = { status: number | null; stdout: string; stderr: string };
type Git = (args: string[]) => GitResult;
type ConfigEntry = { key: string; value: string };

const GITHUB_SECTION = "credential.https://github.com";
const GITHUB_HELPER_KEY = `${GITHUB_SECTION}.helper`;
const GITHUB_USE_HTTP_PATH_KEY = `${GITHUB_SECTION}.usehttppath`;
const DEPLODASH_MARKER = "deplodash-credential-helper";
// Subsections Git's URL matching treats as the whole github.com host, and
// ones it treats as a path prefix on it (only some repositories).
const GITHUB_HOST_SUBSECTION = /^https:\/\/github\.com(?::443)?\/?$/i;
const GITHUB_PATH_SUBSECTION = /^https:\/\/github\.com(?::443)?\/./i;

function spawnGit(args: string[]): GitResult {
    const result = spawnSync("git", args, {
        encoding: "utf8",
        // Outside any repository, so `includeIf` conditions do not depend on
        // where the installer happens to run. LC_ALL keeps Git's messages
        // in English for the "no such section" check.
        cwd: tmpdir(),
        env: { ...process.env, LC_ALL: "C" },
    });
    return {
        status: result.status,
        stdout: String(result.stdout ?? ""),
        // A spawn failure (e.g. git is not installed) has no stderr.
        stderr: String(result.stderr ?? "") || (result.error?.message ?? ""),
    };
}

function gitFailure(args: string[], result: GitResult): Error {
    const detail = result.stderr.trim();
    return new Error(
        `git ${args.join(" ")} failed with exit code ${String(result.status)}${detail ? `: ${detail}` : ""}`
    );
}

function runGit(git: Git, args: string[]): void {
    const result = git(args);
    if (result.status !== 0) throw gitFailure(args, result);
}

/** Run `git config -z <args>` and return its NUL-separated records. */
function readConfigRecords(git: Git, args: string[]): string[] {
    const fullArgs = ["config", "-z", ...args];
    const result = git(fullArgs);
    // Exit 1 means no key matched.
    if (result.status === 1) return [];
    if (result.status !== 0) throw gitFailure(fullArgs, result);
    return result.stdout.split("\0").slice(0, -1);
}

/** Split a `git config -z` record: `key\nvalue`, or a bare boolean `key`. */
function parseConfigEntry(record: string): ConfigEntry {
    const newline = record.indexOf("\n");
    return newline === -1
        ? { key: record, value: "true" }
        : { key: record.slice(0, newline), value: record.slice(newline + 1) };
}

/** Records of `git config --show-scope` limited to system and global config. */
function systemAndGlobalEntries(git: Git, args: string[]): ConfigEntry[] {
    const records = readConfigRecords(git, ["--show-scope", ...args]);
    const entries: ConfigEntry[] = [];
    for (let index = 0; index + 1 < records.length; index += 2) {
        const scope = records[index];
        if (scope !== "system" && scope !== "global") continue;
        entries.push(parseConfigEntry(records[index + 1] ?? ""));
    }
    return entries;
}

/** The URL of a `credential.<url>.helper` key, or "" for `credential.helper`. */
function credentialHelperUrl(key: string): string {
    return key === "credential.helper"
        ? ""
        : key.slice("credential.".length, -".helper".length);
}

/**
 * The helpers Git currently consults for github.com from system and global
 * config, in order: generic ones and every host-wide spelling of github.com
 * (`https://GitHub.com`, a trailing slash, the default port). An empty value
 * resets the list collected so far, exactly as Git applies it.
 * Repository-local and command-line helpers are left out: Git reads them
 * after global config, so they still run after Deplodash. Path-scoped
 * github.com helpers are reported separately because carrying them over
 * would widen them to every repository.
 */
function effectiveFallbackHelpers(git: Git): {
    helpers: string[];
    pathScopedKeys: string[];
} {
    let helpers: string[] = [];
    const pathScopedKeys: string[] = [];
    for (const { key, value } of systemAndGlobalEntries(git, [
        "--includes",
        "--get-regexp",
        "^credential\\.(.+\\.)?helper$",
    ])) {
        const url = credentialHelperUrl(key);
        if (GITHUB_PATH_SUBSECTION.test(url)) {
            pathScopedKeys.push(key);
            continue;
        }
        if (url !== "" && !GITHUB_HOST_SUBSECTION.test(url)) continue;
        helpers = value === "" ? [] : [...helpers, value];
    }
    return {
        helpers: [
            ...new Set(
                helpers.filter((helper) => !helper.includes(DEPLODASH_MARKER))
            ),
        ],
        pathScopedKeys: [...new Set(pathScopedKeys)],
    };
}

/**
 * Register `runnerCommand` as the first credential helper for github.com.
 *
 * Git consults helpers in config order and system config is read before
 * global config, so a system helper (GCM on Git for Windows, osxkeychain on
 * Apple Git) would otherwise answer first. The global github.com section is
 * rebuilt at the end of the file as: an empty value that resets the helper
 * list, the Deplodash runner, then every previously effective helper as a
 * fallback. The user's generic `credential.helper` entries are untouched.
 * `useHttpPath` is required because Git only passes the repository path to
 * helpers when it is set. If a write fails, the previous section is
 * restored.
 *
 * The reset also clears helpers that only apply to some github.com
 * repositories (path-scoped sections, conditional `includeIf` files) because
 * they come earlier in the config; the returned warnings name them.
 */
function configureGitHubHelpers(
    git: Git,
    runnerCommand: string
): { warnings: string[] } {
    const fallback = effectiveFallbackHelpers(git);
    const conditionalIncludes = systemAndGlobalEntries(git, [
        "--get-regexp",
        "^includeif\\.",
    ]);
    // Variable names contain no dots, which keeps sibling hosts such as
    // `https://github.com.example.internal` out of this section.
    const previousSection = readConfigRecords(git, [
        "--global",
        "--get-regexp",
        "^credential\\.https://github\\.com\\.[^.]+$",
    ]).map(parseConfigEntry);
    const add = (key: string, value: string): void =>
        runGit(git, ["config", "--global", "--add", key, value]);
    const removeSection = (): void => {
        const args = ["config", "--global", "--remove-section", GITHUB_SECTION];
        const result = git(args);
        // A missing section (first install) is fine; anything else, such as
        // a locked config file, must not be papered over.
        if (result.status !== 0 && !result.stderr.includes("no such section"))
            throw gitFailure(args, result);
    };

    // Nothing has changed if this fails, so it needs no rollback.
    removeSection();
    try {
        for (const entry of previousSection) {
            const key = entry.key.toLowerCase();
            if (key === GITHUB_HELPER_KEY || key === GITHUB_USE_HTTP_PATH_KEY)
                continue;
            add(entry.key, entry.value);
        }
        add(GITHUB_HELPER_KEY, "");
        add(GITHUB_HELPER_KEY, runnerCommand);
        for (const helper of fallback.helpers) add(GITHUB_HELPER_KEY, helper);
        add(GITHUB_USE_HTTP_PATH_KEY, "true");
    } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
            removeSection();
            for (const entry of previousSection) add(entry.key, entry.value);
        } catch {
            const removeCommand = `git config --global --remove-section ${GITHUB_SECTION}`;
            const recovery =
                previousSection.length === 0
                    ? `Remove the partial section manually with: ${removeCommand}`
                    : `Remove the partial section with \`${removeCommand}\`, then restore these settings manually:\n${previousSection
                          .map((entry) => `  ${entry.key} = ${entry.value}`)
                          .join("\n")}`;
            throw new Error(
                `Git configuration failed (${reason}) and the previous ${GITHUB_SECTION} settings could not be restored. ${recovery}`,
                { cause: error }
            );
        }
        throw new Error(
            `Git configuration failed (${reason}); the previous ${GITHUB_SECTION} settings were restored`,
            { cause: error }
        );
    }

    const sectionHeader = `[credential "https://github.com"]`;
    const warnings = fallback.pathScopedKeys.map(
        (key) =>
            `${key} is now reset by the ${sectionHeader} section. If you still need it, move it below that section in your global Git config.`
    );
    if (conditionalIncludes.length > 0) {
        warnings.push(
            `Your Git config uses includeIf. If an included file sets a credential helper, the ${sectionHeader} section now resets it for github.com; move that includeIf below the section if you still need the helper.`
        );
    }
    return { warnings };
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
    // Prior Deplodash entries are dropped, so reinstalling (e.g. rotating the
    // token) does not stack helpers that each fire a /api/token request.
    const { warnings } = configureGitHubHelpers(
        spawnGit,
        `!node ${shellQuote(runnerPath.replaceAll("\\", "/"))}`
    );
    for (const warning of warnings)
        process.stderr.write(`warning: ${warning}\n`);
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

export type { Git, GitResult };
export { configureGitHubHelpers };
