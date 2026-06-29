#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run
/**
 * deplodash-credential-helper — Git credential helper for deplodash tokens
 *
 * Automatically obtains short-lived GitHub installation tokens from deplodash
 * for git operations.  Scopes are dynamically detected from the pending diff:
 *   - contents:write  (always, covers read too)
 *   - workflows:write (when .github/workflows/ files changed in the diff)
 *
 * Environment variables:
 *   DEPLODASH_URL           — Deplodash API base URL
 *                             (default: https://deplodash.condev.workers.dev)
 *   DEPLODASH_AGENT_TOKEN   — REQUIRED: agent token for deplodash authentication
 *   DEPLODASH_SCOPES       — Override: comma-separated scopes (disables auto-detection)
 *
 * Usage:
 *   git config --global credential.https://github.com.helper \
 *     "!\$(which deno) run --allow-net --allow-env --allow-read --allow-run \
 *       \$HOME/.local/share/deplodash/deplodash-credential-helper.ts"
 *
 *   With inline env vars:
 *     git config --global credential.https://github.com.helper \
 *       "!DEPLODASH_AGENT_TOKEN=xxx \$(which deno) run --allow-net --allow-env --allow-read --allow-run \
 *         \$HOME/.local/share/deplodash/deplodash-credential-helper.ts"
 */

const DEPLODASH_URL =
    Deno.env.get("DEPLODASH_URL") ?? "https://deplodash.condev.workers.dev";
const AGENT_TOKEN = Deno.env.get("DEPLODASH_AGENT_TOKEN");
const OVERRIDE_SCOPES = Deno.env.get("DEPLODASH_SCOPES");

if (!AGENT_TOKEN) {
    console.error(
        "deplodash-credential-helper: DEPLODASH_AGENT_TOKEN is required"
    );
    Deno.exit(1);
}

// ── Parse git credential request ──────────────────────────────────────────

const text = new TextDecoder().decode(await Deno.readAll(Deno.stdin));

const params: Record<string, string> = {};
for (const line of text.split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx > 0) {
        params[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
}

const action = params["action"];
const host = params["host"];
const path = params["path"];

// Only handle GitHub
if (host !== "github.com") {
    console.error(`deplodash-credential-helper: unsupported host '${host}'`);
    Deno.exit(1);
}

// Extract owner/repo from path (e.g., "/owner/repo" or "owner/repo.git")
const repo = path?.replace(/^\//, "").replace(/\.git$/, "");
if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    console.error(
        `deplodash-credential-helper: could not parse repo from path '${path}'`
    );
    Deno.exit(1);
}

// ── Determine scopes ──────────────────────────────────────────────────────

function resolveScopes(): string[] {
    // Explicit override via env var
    if (OVERRIDE_SCOPES) {
        return OVERRIDE_SCOPES.split(",").map((s) => s.trim());
    }

    // Default: always need contents:write
    const scopes = ["contents:write"];

    try {
        // Try upstream diff (most accurate — what will actually be pushed)
        const upCmd = new Deno.Command("git", {
            args: ["diff", "--name-only", "@{upstream}...HEAD"],
            stdout: "piped",
            stderr: "null",
        });
        const upResult = upCmd.outputSync();
        if (upResult.success) {
            const files = new TextDecoder().decode(upResult.stdout);
            if (hasWorkflowFiles(files.split("\n"))) {
                scopes.push("workflows:write");
            }
            return scopes;
        }

        // Fallback: staged diff (for new branches without upstream)
        const stagedCmd = new Deno.Command("git", {
            args: ["diff", "--cached", "--name-only"],
            stdout: "piped",
            stderr: "null",
        });
        const stagedResult = stagedCmd.outputSync();
        if (stagedResult.success) {
            const files = new TextDecoder().decode(stagedResult.stdout);
            if (hasWorkflowFiles(files.split("\n"))) {
                scopes.push("workflows:write");
            }
            return scopes;
        }
    } catch {
        // If git fails entirely, fall through to default
    }

    // Final fallback: check if workflow dir exists in the repo
    try {
        const lsCmd = new Deno.Command("git", {
            args: [
                "ls-tree",
                "-r",
                "HEAD",
                "--name-only",
                ".github/workflows/",
            ],
            stdout: "piped",
            stderr: "null",
        });
        const lsResult = lsCmd.outputSync();
        if (lsResult.success) {
            const output = new TextDecoder().decode(lsResult.stdout);
            if (output.trim().length > 0) {
                scopes.push("workflows:write");
            }
        }
    } catch {
        // ignore
    }

    return scopes;
}

function hasWorkflowFiles(files: string[]): boolean {
    return files.some((f) => f.startsWith(".github/workflows/"));
}

const scopes = resolveScopes();

console.error(
    `deplodash-credential-helper: requesting [${scopes.join(", ")}] for ${repo}`
);

// ── Handle credential actions ─────────────────────────────────────────────

if (action === "get") {
    const response = await fetch(`${DEPLODASH_URL}/api/token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${AGENT_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo, scopes }),
    });

    if (response.status === 202) {
        const data = await response.json();
        console.error(
            `deplodash-credential-helper: consent required — open ${data.url}`
        );
        Deno.exit(1);
    }

    if (!response.ok) {
        const body = await response.text();
        console.error(
            `deplodash-credential-helper: token request failed (${response.status}): ${body}`
        );
        Deno.exit(1);
    }

    const data = await response.json();
    const token = data.token;

    if (!token) {
        console.error("deplodash-credential-helper: no token in response");
        Deno.exit(1);
    }

    // Output credential response for git
    console.log("username=token");
    console.log(`password=${token}`);
} else {
    // For store/erase actions — no-op, tokens are ephemeral
}
