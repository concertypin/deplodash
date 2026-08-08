import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const installerPath = join(scriptsDir, "install-credential-helper.ts");

async function runProcess(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const child = spawn(command, args, { env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const { promise, resolve, reject } = Promise.withResolvers<{
        status: number | null;
        stdout: string;
        stderr: string;
    }>();
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    return promise;
}

void test("installs the helper ahead of existing GitHub helpers and replaces prior Deplodash entries", async () => {
    const helperSource = await readFile(
        join(scriptsDir, "deplodash-credential-helper.ts"),
        "utf8"
    );
    const server = createServer((request, res) => {
        if (request.url === "/deplodash-credential-helper.ts") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(helperSource);
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
    const port = address.port;

    const temp = await mkdtemp(join(tmpdir(), "deplodash-installer-"));
    const config = join(temp, "gitconfig");
    const installDir = join(temp, "share", "deplodash");
    const isolatedEnv = {
        ...process.env,
        HOME: temp,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        DEPLODASH_INSTALL_URL: `http://127.0.0.1:${port}`,
        DEPLODASH_INSTALL_DIR: installDir,
        DEPLODASH_AGENT_TOKEN: "installer-test-token",
    };
    try {
        const configure = (args: string[]) => {
            const result = spawnSync("git", args, {
                env: isolatedEnv,
                encoding: "utf8",
            });
            assert.equal(result.status, 0, String(result.stderr));
        };
        const helperEntries = () => {
            const result = spawnSync(
                "git",
                [
                    "config",
                    "--global",
                    "--get-all",
                    "credential.https://github.com.helper",
                ],
                { env: isolatedEnv, encoding: "utf8" }
            );
            return result.status === 0
                ? result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
                : [];
        };
        const configList = () => {
            const result = spawnSync("git", ["config", "--global", "--list"], {
                env: isolatedEnv,
                encoding: "utf8",
            });
            return result.status === 0
                ? result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
                : [];
        };

        // Pre-existing GitHub-scoped AND generic helpers must be retained as
        // a fallback, with the Deplodash runner moved ahead of both.
        configure([
            "config",
            "--global",
            "--add",
            "credential.https://github.com.helper",
            "!fake-helper",
        ]);
        configure([
            "config",
            "--global",
            "--add",
            "credential.helper",
            "!fake-generic",
        ]);

        const first = await runProcess("node", [installerPath], {
            env: isolatedEnv,
        });
        assert.equal(first.status, 0, first.stderr);
        let entries = helperEntries();
        assert.equal(entries.length, 2);
        const firstEntry = entries[0];
        assert(firstEntry);
        assert.equal(
            firstEntry.includes("deplodash-credential-helper-run.mjs"),
            true,
            `expected Deplodash helper first, got ${JSON.stringify(entries)}`
        );
        assert.equal(entries[1], "!fake-helper");

        // The generic helper is preserved and registered after Deplodash so
        // it is consulted only when the Deplodash helper returns nothing.
        let list = configList();
        const deplodashIndex = list.findIndex((line) =>
            line.includes("deplodash-credential-helper-run.mjs")
        );
        const genericIndex = list.findIndex((line) =>
            line.includes("credential.helper=!fake-generic")
        );
        assert(deplodashIndex >= 0);
        assert(genericIndex >= 0);
        assert(
            deplodashIndex < genericIndex,
            `expected Deplodash before generic helper, got ${JSON.stringify(list)}`
        );

        // Reinstalling (e.g. rotating the token) must not stack duplicates.
        const second = await runProcess("node", [installerPath], {
            env: isolatedEnv,
        });
        assert.equal(second.status, 0, second.stderr);
        entries = helperEntries();
        assert.equal(entries.length, 2);
        const reinstalledFirst = entries[0];
        assert(reinstalledFirst);
        assert.equal(
            reinstalledFirst.includes("deplodash-credential-helper-run.mjs"),
            true
        );
        assert.equal(entries[1], "!fake-helper");
        list = configList();
        assert.equal(
            list.filter((line) =>
                line.includes("deplodash-credential-helper-run.mjs")
            ).length,
            1
        );

        // useHttpPath must not be forced: host-scoped stored credentials
        // keep matching unrelated repository URLs.
        const useHttpPath = spawnSync(
            "git",
            [
                "config",
                "--global",
                "--get",
                "credential.https://github.com.useHttpPath",
            ],
            { env: isolatedEnv, encoding: "utf8" }
        );
        assert.equal(useHttpPath.status, 1);
    } finally {
        server.close();
        await rm(temp, { recursive: true, force: true });
    }
});
