import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { validator } from "hono-openapi";
import * as z from "zod";
import type { HonoEnv, RepoStatus, AppState } from "@/types";
import { authGuard, getSshKey, SSH_COOKIE, MAX_AGE_SECS } from "@/middleware";
import { getOrInitKey, encryptWith } from "@/crypto";
import { normalizeKey, escapeHtml } from "@/helpers";
import { renderSetupPage, renderRegisterPage, renderDashboard } from "@/html";
import type { GitHubClient } from "@/github";
import { TokenExpiredError } from "@/errors";

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const setupPubkeySchema = z.object({
    pubkey: z
        .string()
        .min(1, "SSH public key is required")
        .startsWith("ssh-", "Invalid SSH public key"),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadRepoStatuses(
    client: GitHubClient,
    normalizedKey: string
): Promise<RepoStatus[]> {
    const repos = await client.listAllRepos();

    const statuses: RepoStatus[] = [];
    const adminRepos = repos.filter((r) => r.permissions?.admin);
    const noAdminRepos = repos.filter((r) => !r.permissions?.admin);

    for (let i = 0; i < adminRepos.length; i += 10) {
        const chunk = adminRepos.slice(i, i + 10);
        const results = await Promise.all(
            chunk.map(async (repo): Promise<RepoStatus> => {
                try {
                    const keys = await client.listDeployKeys(
                        repo.owner.login,
                        repo.name
                    );
                    const match = keys.find(
                        (k) => normalizeKey(k.key) === normalizedKey
                    );
                    return {
                        repo,
                        keyId: match?.id ?? null,
                        hasAdmin: true,
                    };
                } catch (err) {
                    if (err instanceof TokenExpiredError) throw err;
                    console.error(
                        `Failed to check deploy keys for ${repo.full_name}:`,
                        err
                    );
                    return { repo, keyId: null, hasAdmin: false };
                }
            })
        );
        statuses.push(...results);
        if (i + 10 < adminRepos.length)
            console.log(
                `  ...${Math.min(i + 10, adminRepos.length)}/${adminRepos.length} checked`
            );
    }
    statuses.push(
        ...noAdminRepos.map(
            (repo): RepoStatus => ({ repo, keyId: null, hasAdmin: false })
        )
    );

    return statuses.sort((a, b) => {
        const rank = (s: RepoStatus) =>
            !s.hasAdmin ? 2 : s.keyId !== null ? 0 : 1;
        return (
            rank(a) - rank(b) ||
            a.repo.full_name.localeCompare(b.repo.full_name)
        );
    });
}

// ─── Page Routes ─────────────────────────────────────────────────────────────
// Mounted at / — paths are /, /setup, /register

export const pagesRouter = new Hono<HonoEnv>()
    .get("/setup", authGuard(), (c) => c.html(renderSetupPage()))
    .post(
        "/setup",
        authGuard(),
        validator("json", setupPubkeySchema),
        async (c) => {
            const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
            const { pubkey } = c.req.valid("json");
            const encrypted = await encryptWith(key, pubkey);
            setCookie(c, SSH_COOKIE, encrypted, {
                path: "/",
                httpOnly: true,
                sameSite: "Lax",
                secure: true,
                maxAge: MAX_AGE_SECS,
            });
            return c.json({ ok: true });
        }
    )

    // ── Dashboard (root) ──────────────────────────────────────────────────────

    .get("/", authGuard(), async (c) => {
        const client = c.get("client")!;
        const sshKey = getSshKey(c);

        if (!sshKey) return c.redirect("/setup");

        // If GITHUB_TOKEN is set via env var, treat as read-only mode
        const readOnly = !!c.env.GITHUB_TOKEN;
        const normalizedKey = normalizeKey(sshKey);

        try {
            const statuses = await loadRepoStatuses(client, normalizedKey);
            const state: AppState = {
                sshKey,
                sshKeyTitle: sshKey.split(/\s+/).slice(-1)[0] || "ssh key",
                normalizedKey,
                repos: statuses,
                loadedAt: new Date(),
                readOnly,
            };
            return c.html(renderDashboard(state));
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/logout");
            }
            const msg = err instanceof Error ? err.message : String(err);
            return c.html(
                `<div class="p-8 text-error">Error: ${escapeHtml(msg)}</div>`
            );
        }
    })
    .get("/register", (c) => {
        const repo = c.req.query("repo") || "";
        const pubkey = c.req.query("pubkey") || getSshKey(c) || "";
        const perm = c.req.query("perm") || "RW";
        const keyName = c.req.query("key_name") || "nanobot";
        const result = c.req.query("_result");
        let success: string | undefined;
        let error: string | undefined;
        if (result) {
            try {
                const parsed = JSON.parse(result) as {
                    ok?: string;
                    error?: string;
                };
                if (parsed.ok) success = parsed.ok;
                else error = parsed.error || "Unknown error";
            } catch {
                // ignore parse errors
            }
        }
        return c.html(
            renderRegisterPage({
                repo,
                pubkey,
                perm,
                keyName,
                ...(success !== undefined ? { success } : {}),
                ...(error !== undefined ? { error } : {}),
            })
        );
    });
