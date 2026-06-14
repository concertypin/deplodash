import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { decryptWith, getOrInitKey } from "@/crypto";
import type { HonoEnv } from "@/types";
import { GitHubClient } from "@/github";
import { isSafeRedirect } from "@/helpers";
import { renderLoginPage } from "@/html";

// ─── Constants ───────────────────────────────────────────────────────────────

export const COOKIE_NAME = "session";
export const SSH_COOKIE = "ssh_key";
export const MAX_AGE_SECS = 30 * 24 * 3600; // 30 days

// ─── Session & SSH-key decryption middleware ─────────────────────────────────

export function sessionMiddleware(): MiddlewareHandler<HonoEnv> {
    return async (c, next) => {
        const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);

        // Decrypt session cookie → gh_token
        const packet = getCookie(c, COOKIE_NAME);
        if (packet) {
            const plain = await decryptWith(key, packet);
            if (plain) c.set("gh_token", plain);
        }

        // Decrypt SSH-key cookie → ssh_key
        const sshPacket = getCookie(c, SSH_COOKIE);
        if (sshPacket) {
            const plain = await decryptWith(key, sshPacket);
            if (!plain) {
                return c.text(
                    "저장된 SSH 키 쿠키를 복호화할 수 없습니다. /setup에서 키를 다시 등록하거나 쿠키를 삭제해주세요.",
                    400
                );
            }
            c.set("ssh_key", plain);
        }

        await next();
    };
}

// ─── Auth guard — redirects to GitHub OAuth if no token ─────────────────────

export function authGuard(): MiddlewareHandler<HonoEnv> {
    return async (c, next) => {
        const token = c.get("gh_token") || c.env.GITHUB_TOKEN;
        if (!token) {
            const url = new URL(c.req.url);
            const target = url.pathname + url.search;
            const safeNext = isSafeRedirect(target) ? target : "/";
            const redirectUrl = `/auth/github?next=${encodeURIComponent(safeNext)}`;
            return c.html(renderLoginPage(redirectUrl));
        }
        c.set("client", new GitHubClient(token));
        await next();
    };
}

// ─── Helper to get SSH key from variable ─────────────────────────────────────

export function getSshKey(c: {
    get: (k: string) => string | undefined;
}): string {
    return c.get("ssh_key") ?? "";
}
