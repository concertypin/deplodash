import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    configureGitHubHelpers,
    confirmInstall,
    unwrapFallback,
    wrappedFallbackCommand,
    type GitResult,
} from "./install-credential-helper.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const installerPath = join(scriptsDir, "install-credential-helper.ts");
const githubHelperKey = "credential.https://github.com.helper";
const fallbackWrapperPath = join(
    scriptsDir,
    "deplodash-credential-fallback.ts"
);
/** Wraps fallbacks with the real wrapper script, as the installer does. */
const wrapFallback = (helper: string): string =>
    wrappedFallbackCommand(fallbackWrapperPath, helper);

async function runProcess(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; input?: string }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
    // A new session has no controlling terminal, so an installer prompt can
    // never block the test run even when it is started from a terminal.
    const child = spawn(command, args, {
        env: options.env,
        detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end(options.input ?? "");
    const { promise, resolve, reject } = Promise.withResolvers<{
        status: number | null;
        stdout: string;
        stderr: string;
    }>();
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    return promise;
}

/** An isolated Git environment with its own system and global config. */
async function isolatedGit(extraEnv: NodeJS.ProcessEnv = {}) {
    const temp = await mkdtemp(join(tmpdir(), "deplodash-installer-"));
    const logPath = join(temp, "helpers.log").replaceAll("\\", "/");
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: temp,
        GIT_CONFIG_GLOBAL: join(temp, "gitconfig"),
        GIT_CONFIG_SYSTEM: join(temp, "system-gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        // The installer matches Git's English "no such section" message.
        LC_ALL: "C",
        ...extraEnv,
    };
    delete env.GIT_CONFIG_NOSYSTEM;
    const git = (args: string[]): GitResult => {
        const result = spawnSync("git", args, { env, encoding: "utf8" });
        return {
            status: result.status,
            stdout: String(result.stdout ?? ""),
            stderr: String(result.stderr ?? ""),
        };
    };
    const configure = (args: string[]): void => {
        const result = spawnSync("git", args, { env, encoding: "utf8" });
        assert.equal(result.status, 0, String(result.stderr));
    };
    const getAll = (args: string[]): string[] => {
        // Keeps empty values: an empty helper entry is a meaningful reset.
        const result = git(["config", ...args]);
        return result.status === 0 && result.stdout.length > 0
            ? result.stdout.replace(/\r?\n$/, "").split(/\r?\n/)
            : [];
    };
    // A fake credential provider that records each `get` it answers (with
    // nothing), so tests can observe which helpers Git consulted and in
    // which order.
    const loggingHelper = (name: string): string =>
        `!f() { test "$1" = get && echo ${name} >> '${logPath}'; true; }; f`;
    const consultedHelpers = async (): Promise<string[]> => {
        const log = await readFile(logPath, "utf8").catch(() => "");
        await writeFile(logPath, "");
        return log.split(/\r?\n/).filter((line) => line.length > 0);
    };
    return {
        temp,
        env,
        git,
        configure,
        getAll,
        loggingHelper,
        consultedHelpers,
        cleanup: () => rm(temp, { recursive: true, force: true }),
    };
}

/** Serves the helper download and a fake /api/token endpoint. */
async function startDeplodashServer() {
    const helperSource = await readFile(
        join(scriptsDir, "deplodash-credential-helper.ts"),
        "utf8"
    );
    const fallbackSource = await readFile(fallbackWrapperPath, "utf8");
    const state: { tokenStatus: number; tokenRequests: unknown[] } = {
        tokenStatus: 200,
        tokenRequests: [],
    };
    const server = createServer((request, res) => {
        if (request.url === "/deplodash-credential-helper.ts") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(helperSource);
            return;
        }
        if (request.url === "/deplodash-credential-fallback.ts") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(fallbackSource);
            return;
        }
        if (request.url === "/api/token") {
            const chunks: string[] = [];
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => chunks.push(chunk));
            request.on("end", () => {
                state.tokenRequests.push(JSON.parse(chunks.join("")));
                res.writeHead(state.tokenStatus, {
                    "content-type": "application/json",
                });
                res.end(
                    JSON.stringify({
                        token: "ghs_test",
                        effective_scopes: ["contents:write", "workflows:write"],
                    })
                );
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    assert(address && typeof address === "object");
    return {
        url: `http://127.0.0.1:${address.port}`,
        state,
        close: () => server.close(),
    };
}

/** An isolated Git environment wired to a fake Deplodash server. */
async function installerSandbox() {
    const server = await startDeplodashServer();
    const env = await isolatedGit({
        DEPLODASH_INSTALL_URL: server.url,
        DEPLODASH_URL: server.url,
        DEPLODASH_AGENT_TOKEN: "installer-test-token",
    });
    const installDir = join(env.temp, "share", "deplodash");
    return {
        server,
        env,
        install: (extraEnv: NodeJS.ProcessEnv = {}, args = ["--yes"]) =>
            runProcess(process.execPath, [installerPath, ...args], {
                env: {
                    ...env.env,
                    DEPLODASH_INSTALL_DIR: installDir,
                    ...extraEnv,
                },
            }),
        fill: () =>
            runProcess("git", ["credential", "fill"], {
                env: env.env,
                input: "url=https://github.com/owner/repo.git\n\n",
            }),
        cleanup: async () => {
            server.close();
            await env.cleanup();
        },
    };
}

void test("a first install on an empty Git config succeeds without Git errors", async () => {
    const { install, fill, cleanup } = await installerSandbox();
    try {
        const result = await install();
        assert.equal(result.status, 0, result.stderr);
        // Only the useHttpPath notice; no Git error or warning.
        assert.doesNotMatch(result.stderr, /fatal|error|warning/i);
        assert.match(result.stderr, /useHttpPath=true/);
        const issued = await fill();
        assert.equal(issued.stdout.includes("password=ghs_test"), true);
    } finally {
        await cleanup();
    }
});

void test("installs Deplodash ahead of system and global helpers, which stay as fallbacks", async () => {
    const { server, env, install, fill, cleanup } = await installerSandbox();
    try {
        // A system helper (like GCM in Git for Windows' system gitconfig),
        // a GitHub-scoped helper, an unrelated key in the GitHub section and
        // a generic global helper.
        env.configure([
            "config",
            "--system",
            "--add",
            "credential.helper",
            env.loggingHelper("system"),
        ]);
        env.configure([
            "config",
            "--global",
            "--add",
            githubHelperKey,
            env.loggingHelper("github-scoped"),
        ]);
        env.configure([
            "config",
            "--global",
            "credential.https://github.com.username",
            "alice",
        ]);
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.helper",
            env.loggingHelper("generic"),
        ]);

        const first = await install();
        assert.equal(first.status, 0, first.stderr);

        // Deplodash answers first: no fallback is consulted, and the
        // repository path reaches the helper (credential.useHttpPath).
        const issued = await fill();
        assert.equal(issued.status, 0, issued.stderr);
        assert.equal(issued.stdout.includes("password=ghs_test"), true);
        assert.deepEqual(await env.consultedHelpers(), []);
        assert.deepEqual(server.state.tokenRequests, [
            {
                repo: "owner/repo",
                scopes: ["contents:write", "workflows:write"],
            },
        ]);

        // When Deplodash cannot issue a token, every previous provider is
        // still consulted, each exactly once and in its original order.
        server.state.tokenStatus = 500;
        const fallback = await fill();
        assert.notEqual(fallback.status, 0);
        assert.deepEqual(await env.consultedHelpers(), [
            "system",
            "github-scoped",
            "generic",
        ]);

        // Unrelated settings survive; the generic helper is untouched.
        assert.deepEqual(
            env.getAll(["--global", "credential.https://github.com.username"]),
            ["alice"]
        );
        assert.deepEqual(
            env.getAll(["--global", "--get-all", "credential.helper"]),
            [env.loggingHelper("generic")]
        );
        assert.deepEqual(
            env.getAll([
                "--global",
                "credential.https://github.com.useHttpPath",
            ]),
            ["true"]
        );

        // Reinstalling (e.g. rotating the token) is idempotent: no stacked
        // Deplodash entries and no duplicated fallbacks.
        const helpersAfterFirstInstall = env.getAll([
            "--global",
            "--get-all",
            githubHelperKey,
        ]);
        assert.equal(helpersAfterFirstInstall.length, 5);
        assert.equal(helpersAfterFirstInstall[0], "");
        assert.equal(
            helpersAfterFirstInstall[1]?.includes(
                "deplodash-credential-helper-run.mjs"
            ),
            true
        );
        const second = await install();
        assert.equal(second.status, 0, second.stderr);
        assert.deepEqual(
            env.getAll(["--global", "--get-all", githubHelperKey]),
            helpersAfterFirstInstall
        );
        await fill();
        assert.deepEqual(await env.consultedHelpers(), [
            "system",
            "github-scoped",
            "generic",
        ]);
    } finally {
        await cleanup();
    }
});

void test("honors an empty-value helper reset when collecting fallbacks", async () => {
    const env = await isolatedGit();
    try {
        // The user disabled the system helper with an empty reset.
        env.configure([
            "config",
            "--system",
            "--add",
            "credential.helper",
            env.loggingHelper("system"),
        ]);
        env.configure(["config", "--global", "--add", "credential.helper", ""]);
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.helper",
            env.loggingHelper("generic"),
        ]);

        configureGitHubHelpers(
            env.git,
            env.loggingHelper("deplodash"),
            wrapFallback
        );

        await runProcess("git", ["credential", "fill"], {
            env: env.env,
            input: "url=https://github.com/owner/repo.git\n\n",
        });
        assert.deepEqual(await env.consultedHelpers(), [
            "deplodash",
            "generic",
        ]);
    } finally {
        await env.cleanup();
    }
});

void test("restores the previous GitHub credential section when a write fails", async () => {
    const env = await isolatedGit();
    try {
        env.configure([
            "config",
            "--global",
            "--add",
            githubHelperKey,
            "!previous-helper",
        ]);
        env.configure([
            "config",
            "--global",
            "credential.https://github.com.username",
            "alice",
        ]);
        const sectionBefore = env.getAll([
            "--global",
            "--get-regexp",
            "^credential\\.https://github\\.com\\.",
        ]);

        const runnerCommand =
            "!node '/opt/deplodash-credential-helper-run.mjs'";
        const failingGit = (args: string[]): GitResult =>
            args.includes(runnerCommand)
                ? {
                      status: 255,
                      stdout: "",
                      stderr: "error: could not lock config file",
                  }
                : env.git(args);
        assert.throws(
            () =>
                configureGitHubHelpers(failingGit, runnerCommand, wrapFallback),
            /settings were restored/
        );

        assert.deepEqual(
            env.getAll([
                "--global",
                "--get-regexp",
                "^credential\\.https://github\\.com\\.",
            ]),
            sectionBefore
        );
    } finally {
        await env.cleanup();
    }
});

void test("fails without touching the config when the old section cannot be removed", async () => {
    const env = await isolatedGit();
    try {
        env.configure([
            "config",
            "--global",
            "--add",
            githubHelperKey,
            "!previous-helper",
        ]);
        const configBefore = env.getAll(["--global", "--list"]);

        // A real removal failure (not "no such section") must not be treated
        // like a first install, or new entries would be appended next to the
        // stale ones.
        const lockedGit = (args: string[]): GitResult =>
            args.includes("--remove-section")
                ? {
                      status: 255,
                      stdout: "",
                      stderr: "error: could not lock config file",
                  }
                : env.git(args);
        assert.throws(
            () =>
                configureGitHubHelpers(
                    lockedGit,
                    "!deplodash-runner",
                    wrapFallback
                ),
            (error: unknown) =>
                error instanceof Error &&
                error.message.includes("could not lock config file") &&
                // Nothing was changed, so the user must not be told to
                // restore anything by hand.
                !error.message.includes("could not be restored")
        );
        assert.deepEqual(env.getAll(["--global", "--list"]), configBefore);
    } finally {
        await env.cleanup();
    }
});

void test("tells the user how to recover when both the write and the restore fail", async () => {
    const env = await isolatedGit();
    try {
        env.configure([
            "config",
            "--global",
            "credential.https://github.com.username",
            "alice",
        ]);
        const runnerCommand = "!deplodash-runner";
        let failing = false;
        const brokenGit = (args: string[]): GitResult => {
            if (args.includes(runnerCommand)) failing = true;
            return failing && args.includes("--add")
                ? { status: 255, stdout: "", stderr: "error: disk full" }
                : env.git(args);
        };
        assert.throws(
            () =>
                configureGitHubHelpers(brokenGit, runnerCommand, wrapFallback),
            (error: unknown) =>
                error instanceof Error &&
                error.message.includes("could not be restored") &&
                error.message.includes(
                    "git config --global --remove-section credential.https://github.com"
                ) &&
                error.message.includes(
                    "credential.https://github.com.username = alice"
                )
        );
    } finally {
        await env.cleanup();
    }
});

void test("leaves sibling hosts that share the github.com prefix alone", async () => {
    const env = await isolatedGit();
    try {
        // A different host whose subsection starts with "https://github.com.".
        const siblingKey =
            "credential.https://github.com.example.internal.helper";
        env.configure(["config", "--global", "--add", siblingKey, "!sibling"]);

        // Installing twice is what used to duplicate the sibling's entries.
        const runnerCommand =
            "!node '/opt/deplodash-credential-helper-run.mjs'";
        configureGitHubHelpers(env.git, runnerCommand, wrapFallback);
        configureGitHubHelpers(env.git, runnerCommand, wrapFallback);

        assert.deepEqual(env.getAll(["--global", "--get-all", siblingKey]), [
            "!sibling",
        ]);
        assert.deepEqual(
            env.getAll(["--global", "--get-all", githubHelperKey]),
            ["", runnerCommand]
        );
    } finally {
        await env.cleanup();
    }
});

void test("keeps every host-wide spelling of github.com as a fallback and warns about narrower ones", async () => {
    const env = await isolatedGit();
    try {
        // Git's URL matching treats all of these as the github.com host.
        env.configure([
            "config",
            "--system",
            "--add",
            githubHelperKey,
            env.loggingHelper("system-github"),
        ]);
        for (const [url, name] of [
            ["https://GitHub.com", "mixed-case"],
            ["https://github.com/", "trailing-slash"],
            ["https://github.com:443", "default-port"],
        ] as const) {
            env.configure([
                "config",
                "--global",
                "--add",
                `credential.${url}.helper`,
                env.loggingHelper(name),
            ]);
        }
        // Applies to some repositories only, so it is not widened.
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.https://github.com/owner.helper",
            env.loggingHelper("path-scoped"),
        ]);
        // Applies only to remotes that carry this user name.
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.https://alice@github.com.helper",
            env.loggingHelper("user-scoped"),
        ]);
        env.configure([
            "config",
            "--global",
            "includeIf.gitdir:~/work/.path",
            "~/work.gitconfig",
        ]);

        const { warnings } = configureGitHubHelpers(
            env.git,
            env.loggingHelper("deplodash"),
            wrapFallback
        );

        await runProcess("git", ["credential", "fill"], {
            env: env.env,
            input: "url=https://github.com/owner/repo.git\n\n",
        });
        assert.deepEqual(await env.consultedHelpers(), [
            "deplodash",
            "system-github",
            "mixed-case",
            "trailing-slash",
            "default-port",
        ]);
        assert.equal(warnings.length, 3);
        for (const expected of [
            "credential.https://github.com/owner.helper",
            "credential.https://alice@github.com.helper",
            "includeIf",
        ]) {
            assert.equal(
                warnings.some((warning) => warning.includes(expected)),
                true,
                `missing warning for ${expected}: ${JSON.stringify(warnings)}`
            );
        }
    } finally {
        await env.cleanup();
    }
});

void test("replaces an existing useHttpPath setting instead of duplicating it", async () => {
    const env = await isolatedGit();
    try {
        env.configure([
            "config",
            "--global",
            "credential.https://github.com.useHttpPath",
            "false",
        ]);

        const { warnings } = configureGitHubHelpers(
            env.git,
            env.loggingHelper("deplodash"),
            wrapFallback
        );

        assert.deepEqual(warnings, []);
        assert.deepEqual(
            env.getAll([
                "--global",
                "--get-all",
                "credential.https://github.com.useHttpPath",
            ]),
            ["true"]
        );
    } finally {
        await env.cleanup();
    }
});

void test("reports a missing git binary instead of a bare exit code", async () => {
    const { install, cleanup } = await installerSandbox();
    try {
        // An empty PATH directory: node is started by absolute path, and git
        // cannot be found even where it shares a directory with node.
        const emptyBin = await mkdtemp(join(tmpdir(), "deplodash-no-git-"));
        const pathKeys = Object.keys(process.env).filter(
            (key) => key.toUpperCase() === "PATH"
        );
        const withoutGit: NodeJS.ProcessEnv = Object.fromEntries(
            pathKeys.map((key) => [key, emptyBin])
        );
        try {
            const result = await install(withoutGit);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /ENOENT/);
        } finally {
            await rm(emptyBin, { recursive: true, force: true });
        }
    } finally {
        await cleanup();
    }
});

void test("upgrades the layout written by the previous installer", async () => {
    const env = await isolatedGit();
    try {
        // The earlier installer put its runner first in the github.com
        // section, kept other GitHub helpers after it, and wrote no reset.
        env.configure([
            "config",
            "--system",
            "--add",
            "credential.helper",
            env.loggingHelper("system"),
        ]);
        env.configure([
            "config",
            "--global",
            "--add",
            githubHelperKey,
            "!node '/old/deplodash-credential-helper-run.mjs'",
        ]);
        env.configure([
            "config",
            "--global",
            "--add",
            githubHelperKey,
            env.loggingHelper("old-github"),
        ]);
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.helper",
            env.loggingHelper("generic"),
        ]);

        configureGitHubHelpers(
            env.git,
            env.loggingHelper("deplodash"),
            wrapFallback
        );

        await runProcess("git", ["credential", "fill"], {
            env: env.env,
            input: "url=https://github.com/owner/repo.git\n\n",
        });
        // The stale runner is gone and every provider runs exactly once.
        assert.deepEqual(await env.consultedHelpers(), [
            "deplodash",
            "system",
            "old-github",
            "generic",
        ]);
        assert.equal(
            env
                .getAll(["--global", "--get-all", githubHelperKey])
                .some((helper) => helper.includes("/old/")),
            false
        );
    } finally {
        await env.cleanup();
    }
});

void test("explains that Git 2.26 is required when --show-scope is unknown", async () => {
    const env = await isolatedGit();
    try {
        env.configure([
            "config",
            "--global",
            "--add",
            githubHelperKey,
            "!previous-helper",
        ]);
        const configBefore = env.getAll(["--global", "--list"]);
        // Git before 2.26 rejects --show-scope as a usage error (exit 129).
        const oldGit = (args: string[]): GitResult =>
            args.includes("--show-scope")
                ? {
                      status: 129,
                      stdout: "",
                      stderr: "error: unknown option `show-scope'",
                  }
                : env.git(args);
        assert.throws(
            () =>
                configureGitHubHelpers(
                    oldGit,
                    "!deplodash-runner",
                    wrapFallback
                ),
            /Git 2\.26 or newer is required/
        );
        assert.deepEqual(env.getAll(["--global", "--list"]), configBefore);
    } finally {
        await env.cleanup();
    }
});

void test("fallback providers never store Deplodash installation tokens but keep working", async () => {
    const { server, env, install, cleanup } = await installerSandbox();
    const storeLog = join(env.temp, "store.log").replaceAll("\\", "/");
    // A persistent provider: answers `get` with the user's own credential
    // and records everything it is asked to `store`.
    const provider = `!f() { case "$1" in get) printf 'username=alice\npassword=personal\n' ;; store) cat >> '${storeLog}' ;; esac; true; }; f`;
    const credential = (action: string, input: string) =>
        runProcess("git", ["credential", action], { env: env.env, input });
    const request = "url=https://github.com/owner/repo.git\n\n";
    try {
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.helper",
            provider,
        ]);
        const installed = await install();
        assert.equal(installed.status, 0, installed.stderr);

        // Deplodash answers first; Git then approves the token to every
        // helper, as it does after a successful push.
        const issued = await credential("fill", request);
        assert.equal(issued.stdout.includes("password=ghs_test"), true);
        const approved = await credential("approve", `${issued.stdout}\n`);
        assert.equal(approved.status, 0, approved.stderr);
        assert.equal(
            (await readFile(storeLog, "utf8").catch(() => "")).includes("ghs_"),
            false
        );

        // The user's own credentials still reach the provider.
        await credential(
            "approve",
            "protocol=https\nhost=github.com\npath=owner/repo.git\nusername=alice\npassword=personal\n\n"
        );
        assert.equal(
            (await readFile(storeLog, "utf8")).includes("password=personal"),
            true
        );

        // When Deplodash cannot issue a token, the wrapped provider answers.
        server.state.tokenStatus = 500;
        const fallback = await credential("fill", request);
        assert.equal(fallback.status, 0, fallback.stderr);
        assert.equal(fallback.stdout.includes("password=personal"), true);
    } finally {
        await cleanup();
    }
});

void test("unwraps only entries produced by the fallback wrapper", () => {
    const helper = "!f() { echo 'it''s'; }; f";
    assert.equal(unwrapFallback(wrapFallback(helper)), helper);
    // A different install directory still unwraps.
    assert.equal(
        unwrapFallback(
            wrappedFallbackCommand(
                "/home/x/other dir/deplodash-credential-fallback.ts",
                "manager"
            )
        ),
        "manager"
    );
    // Plain helpers, and user helpers that merely mention the marker, stay.
    for (const value of [
        "manager",
        "!node '/opt/tools/helper.mjs' 'deplodash-credential-fallback.ts'",
        "store --file '/tmp/deplodash-credential-fallback.ts'",
    ]) {
        assert.equal(unwrapFallback(value), value);
    }
});

void test("reinstalling over wrapped adversarial helpers leaves the config byte-identical", async () => {
    const env = await isolatedGit();
    try {
        for (const helper of [
            '!f() { echo "it\'s $1"; }; f',
            "/opt/my tools/git-credential-x --flag 'a b'",
            "'",
        ]) {
            env.configure([
                "config",
                "--global",
                "--add",
                "credential.helper",
                helper,
            ]);
        }
        const runner = "!node '/opt/deplodash-credential-helper-run.mjs'";
        configureGitHubHelpers(env.git, runner, wrapFallback);
        const first = await readFile(join(env.temp, "gitconfig"), "utf8");
        configureGitHubHelpers(env.git, runner, wrapFallback);
        assert.equal(
            await readFile(join(env.temp, "gitconfig"), "utf8"),
            first
        );
        // Each original helper is wrapped exactly once.
        assert.equal(
            env
                .getAll(["--global", "--get-all", githubHelperKey])
                .filter((value) =>
                    value.includes("deplodash-credential-fallback")
                ).length,
            3
        );
    } finally {
        await env.cleanup();
    }
});

void test("explains the useHttpPath side effect and needs consent before installing", async () => {
    const notices: string[] = [];
    const notice = (text: string) => notices.push(text);
    const ask = (answer: boolean | null) => async () => answer;

    await confirmInstall([], ask(true), notice);
    await confirmInstall(["--yes"], ask(null), notice);
    await assert.rejects(confirmInstall([], ask(false), notice), /cancelled/);
    // Nobody to ask: stop and point at --yes instead of guessing.
    await assert.rejects(confirmInstall([], ask(null), notice), /--yes/);
    // The notice is shown every time, even when --yes skips the question.
    assert.equal(notices.length, 4);
    assert.equal(
        notices.every((text) => text.includes("useHttpPath=true")),
        true
    );
});

void test("an install without a terminal and without --yes changes nothing", async () => {
    const { env, install, cleanup } = await installerSandbox();
    try {
        env.configure([
            "config",
            "--global",
            "--add",
            "credential.helper",
            "!previous-helper",
        ]);
        const configBefore = env.getAll(["--global", "--list"]);
        const result = await install({}, []);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /useHttpPath=true/);
        assert.match(result.stderr, /--yes/);
        assert.deepEqual(env.getAll(["--global", "--list"]), configBefore);
    } finally {
        await cleanup();
    }
});
