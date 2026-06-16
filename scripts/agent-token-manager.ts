/**
 * Agent Token Manager — CLI helper for managing deplodash agent tokens in KV.
 *
 * Usage:
 *   pnpm run token list [--local]
 *   pnpm run token create <agent-id> [--label <name>] [--local]
 *   pnpm run token revoke <token> [--local]
 *
 * Or directly:
 *   node scripts/agent-token-manager.ts list [--local]
 *
 * Options:
 *   --local    Operate on local KV (for wrangler dev)
 */

import { spawn } from "child_process";
import { randomBytes } from "crypto";

interface TokenRecord {
    agent_id: string;
    label: string;
    created_at: string;
}

const cliArgs = process.argv.slice(2);
const cliCmd = cliArgs[0];
const isLocal = cliArgs.includes("--local");
const localFlag = isLocal ? ["--local"] : [];
const binding = ["--binding", "KV"];

function help(): void {
    console.log(`
Usage:
  list                              List all agent tokens
  create <agent-id> [--label <n>]   Create a new token
  revoke <token>                    Revoke/delete a token

Options:
  --local    Operate on local KV (wrangler dev)
`);
}

function tokenKey(token: string): string {
    return `agent_tokens:${token}`;
}

async function runWrangler(
    wrArgs: string[]
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const isWin = process.platform === "win32";
        const cmd = isWin ? "cmd" : "npx";
        const args = isWin
            ? ["/d", "/s", "/c", "npx", "wrangler", "kv", "key", ...wrArgs]
            : ["wrangler", "kv", "key", ...wrArgs];
        const proc = spawn(cmd, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
        proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
        proc.on("close", (code) => {
            if (code === 0) resolve({ stdout: out, stderr: err });
            else reject(new Error(err || `exit code ${code}`));
        });
        proc.on("error", reject);
    });
}

async function listTokens(): Promise<void> {
    const result = await runWrangler([
        "list",
        ...binding,
        "--prefix",
        "agent_tokens:",
        ...localFlag,
    ]);
    let entries: { name: string }[] = [];
    try {
        entries = JSON.parse(result.stdout.trim()) as { name: string }[];
    } catch {
        entries = result.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => {
                try {
                    return JSON.parse(l) as { name: string };
                } catch {
                    return null;
                }
            })
            .filter((e): e is { name: string } => e !== null);
    }
    if (entries.length === 0) {
        console.log("No agent tokens found.");
        return;
    }

    for (const entry of entries) {
        const key = entry.name;
        const token = key.replace("agent_tokens:", "");
        try {
            const getResult = await runWrangler([
                "get",
                ...binding,
                key,
                ...localFlag,
            ]);
            const val = JSON.parse(getResult.stdout.trim()) as TokenRecord;
            console.log(
                `  ${token.padEnd(36)}  agent_id=${val.agent_id}  label=${val.label || "-"}  created=${(val.created_at || "").slice(0, 10)}`
            );
        } catch {
            console.log(`  ${token.padEnd(36)}  (failed to fetch value)`);
        }
    }
}

async function createToken(agentId: string, label: string): Promise<void> {
    const token = randomBytes(24).toString("hex");
    const value = JSON.stringify({
        agent_id: agentId,
        label: label || agentId,
        created_at: new Date().toISOString(),
    });
    const key = tokenKey(token);
    console.log(`Registering token for agent "${agentId}"...`);
    await runWrangler(["put", ...binding, key, value, ...localFlag]);
    console.log(`\n  Token: ${token}\n`);
    console.log(`  Authorization: Bearer ${token}`);
}

async function revokeToken(token: string): Promise<void> {
    const key = tokenKey(token);
    console.log(`Revoking token ${token.slice(0, 16)}...`);
    await runWrangler(["delete", ...binding, key, ...localFlag]);
    console.log("Done.");
}

async function main(): Promise<void> {
    try {
        switch (cliCmd) {
            case "list":
                await listTokens();
                break;
            case "create": {
                const agentId = cliArgs[1];
                if (!agentId || agentId.startsWith("--")) {
                    console.error("Error: agent-id is required");
                    help();
                    process.exit(1);
                }
                const labelIdx = cliArgs.indexOf("--label");
                const label =
                    labelIdx !== -1 && cliArgs[labelIdx + 1]
                        ? cliArgs[labelIdx + 1]!
                        : agentId;
                await createToken(agentId, label);
                break;
            }
            case "revoke": {
                const token = cliArgs[1];
                if (!token || token.startsWith("--")) {
                    console.error("Error: token is required");
                    help();
                    process.exit(1);
                }
                await revokeToken(token);
                break;
            }
            default:
                help();
                process.exit(1);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}

void main();
