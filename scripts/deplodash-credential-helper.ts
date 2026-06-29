#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * deplodash-credential-helper — Git credential helper for deplodash tokens
 *
 * Automatically obtains short-lived GitHub installation tokens from deplodash
 * for git operations (push, clone, fetch, etc.).
 *
 * Environment variables:
 *   DEPLODASH_URL           — Deplodash API base URL
 *                             (default: https://deplodash.condev.workers.dev)
 *   DEPLODASH_AGENT_TOKEN   — REQUIRED: agent token for deplodash authentication
 *   DEPLODASH_SCOPES       — comma-separated scopes (default: contents:write)
 *
 * Configuration
 *   --global or --local git config:
 *     git config --global credential.https://github.com.helper \
 *       "!\$(which deno) run --allow-net --allow-env --allow-read \
 *         \$HOME/.local/share/deplodash/deplodash-credential-helper.ts"
 *
 *   Or inline env vars:
 *     git config --global credential.https://github.com.helper \
 *       "!DEPLODASH_AGENT_TOKEN=xxx \$(which deno) run --allow-net --allow-env \
 *         /path/to/deplodash-credential-helper.ts"
 */

const DEPLODASH_URL =
    Deno.env.get("DEPLODASH_URL") ?? "https://deplodash.condev.workers.dev";
const AGENT_TOKEN = Deno.env.get("DEPLODASH_AGENT_TOKEN");
const SCOPES = (Deno.env.get("DEPLODASH_SCOPES") ?? "contents:write")
    .split(",")
    .map((s) => s.trim());

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

// ── Handle credential actions ─────────────────────────────────────────────

if (action === "get") {
    const response = await fetch(`${DEPLODASH_URL}/api/token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${AGENT_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo, scopes: SCOPES }),
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
    // Nothing to store or erase.
}
