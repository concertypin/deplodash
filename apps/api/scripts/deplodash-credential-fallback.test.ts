import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
    QUIT_HELPER,
    isInstallationToken,
    runFallback,
    type GitRun,
} from "./deplodash-credential-fallback.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const description = "protocol=https\nhost=github.com\npath=owner/repo.git\n";

function recordingGit(
    result: { status: number | null; stdout: string },
    stderrLines: string[] = []
): {
    calls: Array<{ args: string[]; input: string }>;
    runGit: GitRun;
} {
    const calls: Array<{ args: string[]; input: string }> = [];
    return {
        calls,
        runGit: async (args, input, onStderrLine) => {
            calls.push({ args, input });
            for (const line of stderrLines) onStderrLine(line);
            return result;
        },
    };
}

/** Run the wrapper as Git would, with an isolated Git config. */
async function runWrapper(
    wrapperPath: string,
    helper: string,
    action: string,
    input: string
): Promise<{ stdout: string; stderr: string }> {
    const temp = await mkdtemp(join(tmpdir(), "deplodash-fallback-"));
    try {
        const child = spawn(process.execPath, [wrapperPath, helper, action], {
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: join(temp, "gitconfig"),
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.stdin.end(input);
        await new Promise((resolve) => child.on("close", resolve));
        return { stdout, stderr };
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}

void test("recognizes GitHub App installation tokens", () => {
    assert.equal(
        isInstallationToken(
            `${description}username=x-access-token\npassword=ghs_abc\n`
        ),
        true
    );
    assert.equal(
        isInstallationToken(`${description}username=alice\npassword=gho_abc\n`),
        false
    );
    // Only the password field counts, not a path or user that contains ghs_.
    assert.equal(
        isInstallationToken(
            "protocol=https\nhost=github.com\npath=ghs_/repo.git\nusername=ghs_bot\npassword=secret\n"
        ),
        false
    );
});

void test("never forwards an installation token to the wrapped helper", async () => {
    const git = recordingGit({ status: 0, stdout: "" });
    const token = `${description}username=x-access-token\npassword=ghs_abc\n`;
    for (const action of ["store", "erase"]) {
        assert.equal(
            await runFallback("manager", action, token, () => {}, git.runGit),
            ""
        );
    }
    assert.equal(git.calls.length, 0);
});

void test("forwards other credentials to the wrapped helper only", async () => {
    const git = recordingGit({ status: 0, stdout: "" });
    const input = `${description}username=alice\npassword=personal\n`;
    await runFallback("manager", "store", input, () => {}, git.runGit);
    await runFallback("manager", "erase", input, () => {}, git.runGit);
    const reset = [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=manager",
    ];
    assert.deepEqual(git.calls, [
        { args: [...reset, "credential", "approve"], input },
        { args: [...reset, "credential", "reject"], input },
    ]);
});

void test("asks the wrapped helper on get behind a quit guard", async () => {
    const answered = recordingGit({
        status: 0,
        stdout: `${description}username=alice\npassword=personal\n`,
    });
    const stdout = await runFallback(
        "manager",
        "get",
        description,
        () => {},
        answered.runGit
    );
    assert.equal(stdout.includes("password=personal"), true);
    assert.deepEqual(answered.calls[0]?.args, [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=manager",
        "-c",
        `credential.helper=${QUIT_HELPER}`,
        "credential",
        "fill",
    ]);
});

void test("passes the helper's own messages through and hides only the guard's", async () => {
    const written: string[] = [];
    const git = recordingGit({ status: 128, stdout: "" }, [
        "Open https://github.com/login/device and enter ABCD-1234",
        `fatal: credential helper '${QUIT_HELPER}' told us to quit`,
    ]);
    const stdout = await runFallback(
        "manager",
        "get",
        description,
        (text) => written.push(text),
        git.runGit
    );
    assert.equal(stdout, "");
    assert.deepEqual(written, [
        "Open https://github.com/login/device and enter ABCD-1234\n",
    ]);
});

void test("ignores unknown actions and a missing helper", async () => {
    const git = recordingGit({ status: 0, stdout: "x" });
    assert.equal(
        await runFallback(
            "manager",
            "other",
            description,
            () => {},
            git.runGit
        ),
        ""
    );
    assert.equal(
        await runFallback(undefined, "get", description, () => {}, git.runGit),
        ""
    );
    assert.equal(git.calls.length, 0);
});

void test("a real get miss through Git stays silent", async () => {
    // A helper that has nothing: Git reaches the quit guard, which must not
    // leak an error to the user.
    const result = await runWrapper(
        join(scriptsDir, "deplodash-credential-fallback.ts"),
        "!f() { true; }; f",
        "get",
        `${description}\n`
    );
    assert.deepEqual(result, { stdout: "", stderr: "" });
});

void test("runs when Git launches it through a symlinked directory", async () => {
    const linkParent = await mkdtemp(join(tmpdir(), "deplodash-link-"));
    const linkedDir = join(linkParent, "scripts");
    try {
        // A junction on Windows (no privileges needed), a symlink elsewhere.
        await symlink(scriptsDir, linkedDir, "junction");
        const result = await runWrapper(
            join(linkedDir, "deplodash-credential-fallback.ts"),
            "!f() { printf 'username=alice\\npassword=personal\\n'; }; f",
            "get",
            `${description}\n`
        );
        assert.equal(result.stdout.includes("password=personal"), true);
    } finally {
        await rm(linkParent, { recursive: true, force: true });
    }
});
