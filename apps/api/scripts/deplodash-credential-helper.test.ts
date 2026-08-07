import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCredentialRequest } from "./deplodash-credential-helper.ts";

type Call = { args: string[] };

const input = "protocol=https\nhost=github.com\npath=/owner/repo.git\n\n";
const env = {
    DEPLODASH_AGENT_TOKEN: "agent-secret",
    DEPLODASH_URL: "https://example.test/",
} satisfies NodeJS.ProcessEnv;

function response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
}

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
    if (options.input !== undefined) {
        child.stdin.write(options.input);
        child.stdin.end();
    }
    const { promise, resolve, reject } = Promise.withResolvers<{
        status: number | null;
        stdout: string;
        stderr: string;
    }>();
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    return promise;
}

function gitRunner(results: Array<{ success: boolean; stdout: string }>): {
    calls: Call[];
    runGit: (args: string[]) => { success: boolean; stdout: string };
} {
    const calls: Call[] = [];
    return {
        calls,
        runGit: (args) => {
            calls.push({ args });
            return results.shift() ?? { success: false, stdout: "" };
        },
    };
}

async function getResult(
    fetch: typeof globalThis.fetch,
    runGit: (args: string[]) => { success: boolean; stdout: string },
    overrides: Partial<NodeJS.ProcessEnv> = {}
) {
    return handleCredentialRequest(
        "get",
        input,
        { ...env, ...overrides },
        { fetch, runGit }
    );
}

const SUCCESS_SCOPES = ["contents:write", "workflows:write"];

void test("returns credentials for a successful token request", async () => {
    let request: Request | undefined;
    const result = await getResult(
        async (url, init) => {
            request = new Request(url, init);
            return response(200, {
                token: "ghs_test",
                effective_scopes: SUCCESS_SCOPES,
            });
        },
        () => ({ success: true, stdout: "" })
    );
    assert.equal(
        result.stdout,
        "username=x-access-token\npassword=ghs_test\n\n"
    );
    assert.equal(result.stderr, "");
    assert.equal(request?.url, "https://example.test/api/token");
    assert.equal(request?.headers.get("authorization"), "Bearer agent-secret");
    assert.deepEqual(await request?.json(), {
        repo: "owner/repo",
        scopes: SUCCESS_SCOPES,
    });
});

void test("scope override bypasses git probes", async () => {
    const runner = gitRunner([]);
    const result = await getResult(
        async () =>
            response(200, {
                token: "ghs_test",
                effective_scopes: ["contents:read", "workflows:write"],
            }),
        runner.runGit,
        { DEPLODASH_SCOPES: " contents:read, workflows:write,contents:read " }
    );
    assert.equal(
        result.stdout,
        "username=x-access-token\npassword=ghs_test\n\n"
    );
    assert.equal(runner.calls.length, 0);
});

void test("requests workflow permission conservatively when no override is set", async () => {
    const runner = gitRunner([]);
    const result = await getResult(async (_url, init) => {
        assert.deepEqual(await new Request(_url, init).json(), {
            repo: "owner/repo",
            scopes: SUCCESS_SCOPES,
        });
        return response(200, {
            token: "ghs_test",
            effective_scopes: SUCCESS_SCOPES,
        });
    }, runner.runGit);
    assert.equal(result.stdout.includes("ghs_test"), true);
    assert.equal(runner.calls.length, 0);
});

void test("rejects a token whose effective scopes are narrower than requested", async () => {
    const result = await getResult(
        async () =>
            response(200, {
                token: "ghs_test",
                effective_scopes: ["contents:read"],
            }),
        () => ({ success: true, stdout: "" })
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("contents:write"), true);
    assert.equal(result.stderr.includes("workflows:write"), true);
    assert.equal(result.stderr.includes("ghs_test"), false);
});

void test("handles Git LFS paths and explicit default HTTPS port", async () => {
    const lfsResult = await handleCredentialRequest(
        "get",
        "protocol=https\nhost=github.com\npath=/owner/repo.git/info/lfs/objects/batch\n\n",
        env,
        {
            fetch: async (_url, init) => {
                assert.deepEqual(await new Request(_url, init).json(), {
                    repo: "owner/repo",
                    scopes: SUCCESS_SCOPES,
                });
                return response(200, {
                    token: "ghs_test",
                    effective_scopes: SUCCESS_SCOPES,
                });
            },
            runGit: () => ({ success: true, stdout: "" }),
        }
    );
    assert.equal(
        lfsResult.stdout,
        "username=x-access-token\npassword=ghs_test\n\n"
    );

    const portResult = await handleCredentialRequest(
        "get",
        "protocol=https\nhost=github.com:443\npath=/owner/repo.git\n\n",
        env,
        {
            fetch: async () =>
                response(200, {
                    token: "ghs_test",
                    effective_scopes: SUCCESS_SCOPES,
                }),
            runGit: () => ({ success: true, stdout: "" }),
        }
    );
    assert.equal(
        portResult.stdout,
        "username=x-access-token\npassword=ghs_test\n\n"
    );
});

void test("ignores unsupported actions and contexts without work", async () => {
    const runner = gitRunner([]);
    for (const action of [undefined, "store", "erase", "other"]) {
        const result = await handleCredentialRequest(action, input, env, {
            fetch: async () => response(500, {}),
            runGit: runner.runGit,
        });
        assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 });
    }
    const nonGitHub = await handleCredentialRequest(
        "get",
        "protocol=https\nhost=gitlab.com\npath=/owner/repo.git\n",
        env,
        {
            fetch: async () => response(500, {}),
            runGit: runner.runGit,
        }
    );
    assert.deepEqual(nonGitHub, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(runner.calls.length, 0);
});

void test("reports applicable failures without leaking secrets or quitting", async () => {
    // Unconfigured helper (no token) stays silent so Git can fall through
    // to the user's other credential providers.
    const missingToken = await getResult(
        async () => response(200, {}),
        () => ({ success: true, stdout: "" }),
        {
            DEPLODASH_AGENT_TOKEN: "",
        }
    );
    assert.deepEqual(missingToken, {
        stdout: "",
        stderr: "",
        exitCode: 0,
    });

    const consent = await getResult(
        async () =>
            response(202, {
                url: "https://example.test/auth/consent?repo=owner%2Frepo",
            }),
        () => ({ success: true, stdout: "" })
    );
    assert.equal(consent.stdout, "");
    const consentUrlMatch = /consent required: (\S+)/.exec(consent.stderr);
    assert(consentUrlMatch);
    const consentUrlValue = consentUrlMatch[1];
    assert(consentUrlValue);
    const consentUrl = new URL(consentUrlValue);
    assert.equal(consentUrl.origin, "https://example.test");
    assert.equal(consentUrl.pathname, "/auth/consent");
    assert.equal(consent.stderr.includes("agent-secret"), false);

    const malformed = await getResult(
        async () => new Response("not-json", { status: 200 }),
        () => ({ success: true, stdout: "" })
    );
    assert.equal(malformed.stdout, "");

    const badScopes = await getResult(
        async () => response(200, { token: "ghs_test" }),
        () => ({ success: true, stdout: "" }),
        {
            DEPLODASH_SCOPES: " , ",
        }
    );
    assert.equal(badScopes.stdout, "");
    assert.equal(badScopes.stderr.includes("DEPLODASH_SCOPES"), true);
});

void test("sends repository mode when DEPLODASH_REPO_MODE opts in", async () => {
    const result = await getResult(
        async (_url, init) => {
            assert.deepEqual(await new Request(_url, init).json(), {
                repo: "owner/repo",
                scopes: SUCCESS_SCOPES,
                repo_mode: "create-if-missing",
            });
            return response(200, {
                token: "ghs_test",
                effective_scopes: SUCCESS_SCOPES,
            });
        },
        () => ({ success: true, stdout: "" }),
        { DEPLODASH_REPO_MODE: "create-if-missing" }
    );
    assert.equal(result.stdout.includes("ghs_test"), true);
});

void test("rejects an invalid DEPLODASH_REPO_MODE without leaking secrets", async () => {
    const result = await getResult(
        async () => response(200, { token: "ghs_test" }),
        () => ({ success: true, stdout: "" }),
        { DEPLODASH_REPO_MODE: "delete-everything" }
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("DEPLODASH_REPO_MODE"), true);
});

void test("works through git credential fill with an isolated helper configuration", async () => {
    const requests: Array<{ repo: string; scopes: string[] }> = [];
    const server = createServer((request, res) => {
        void (async () => {
            const chunks: string[] = [];
            request.setEncoding("utf8");
            for await (const chunk of request) chunks.push(String(chunk));
            const body: unknown = JSON.parse(chunks.join(""));
            if (
                typeof body === "object" &&
                body !== null &&
                "repo" in body &&
                "scopes" in body &&
                Array.isArray(body.scopes)
            ) {
                requests.push({
                    repo: String(body.repo),
                    scopes: body.scopes.filter(
                        (scope): scope is string => typeof scope === "string"
                    ),
                });
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    token: "ghs_test",
                    effective_scopes: ["contents:write"],
                })
            );
        })().catch(() => {
            res.writeHead(500);
            res.end();
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;
    const temp = await mkdtemp(join(tmpdir(), "deplodash-credential-"));
    const config = join(temp, "gitconfig");
    const isolatedEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        DEPLODASH_AGENT_TOKEN: "agent-secret",
        DEPLODASH_URL: `http://127.0.0.1:${port}`,
        DEPLODASH_SCOPES: "contents:write",
    };
    try {
        const configure = (args: string[]) => {
            const result = spawnSync("git", args, {
                env: isolatedEnv,
                encoding: "utf8",
            });
            assert.equal(result.status, 0, String(result.stderr));
        };
        configure([
            "config",
            "--global",
            "--replace-all",
            "credential.https://github.com.helper",
            "",
        ]);
        const helperCommand = join(
            process.cwd(),
            "scripts/deplodash-credential-helper.ts"
        ).replaceAll("\\", "/");
        configure([
            "config",
            "--global",
            "--add",
            "credential.https://github.com.helper",
            `!node "${helperCommand}"`,
        ]);
        configure([
            "config",
            "--global",
            "credential.https://github.com.useHttpPath",
            "true",
        ]);
        const result = await runProcess("git", ["credential", "fill"], {
            env: isolatedEnv,
            input: "url=https://github.com/owner/repo.git\n\n",
        });
        assert.equal(result.status, 0, String(result.stderr));
        assert.equal(result.stdout.includes("username=x-access-token"), true);
        assert.equal(result.stdout.includes("password=ghs_test"), true);
        assert.deepEqual(requests, [
            { repo: "owner/repo", scopes: ["contents:write"] },
        ]);
    } finally {
        server.close();
        await rm(temp, { recursive: true, force: true });
    }
});
