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
    type GitResult,
} from "./install-credential-helper.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const installerPath = join(scriptsDir, "install-credential-helper.ts");
const githubHelperKey = "credential.https://github.com.helper";

async function runProcess(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; input?: string }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const child = spawn(command, args, { env: options.env });
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
        install: () =>
            runProcess("node", [installerPath], {
                env: { ...env.env, DEPLODASH_INSTALL_DIR: installDir },
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
        assert.equal(result.stderr, "");
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

        configureGitHubHelpers(env.git, env.loggingHelper("deplodash"));

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
            () => configureGitHubHelpers(failingGit, runnerCommand),
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
            () => configureGitHubHelpers(lockedGit, "!deplodash-runner"),
            /could not lock config file/
        );
        assert.deepEqual(env.getAll(["--global", "--list"]), configBefore);
    } finally {
        await env.cleanup();
    }
});
