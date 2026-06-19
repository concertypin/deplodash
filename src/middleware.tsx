import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { decryptWith, encryptWith, getOrInitKey } from "@/crypto";
import type { HonoEnv, SessionPayload } from "@/types";
import { GitHubClient } from "@/github";
import { isSafeRedirect } from "@/helpers";
import { LoginPage, renderPage } from "@/views";

// ─── Constants ───────────────────────────────────────────────────────────────

export const COOKIE_NAME = "session";
export const MAX_AGE_SECS = 30 * 24 * 3600; // 30 days

// ─── Session cookie decryption + auto-refresh middleware ─────────────────────

export function sessionMiddleware(): MiddlewareHandler<HonoEnv> {
    return async (c, next) => {
        const key = await getOrInitKey(c.env.ENCRYPTION_SECRET);
        const packet = getCookie(c, COOKIE_NAME);

        if (packet) {
            const plain = await decryptWith(key, packet);
            if (plain) {
                let session: SessionPayload | null = null;
                try {
                    session = JSON.parse(plain) as SessionPayload;
                } catch {
                    // Legacy format: just a plain access_token string
                    c.set("gh_token", plain);
                }

                if (session) {
                    const now = Date.now();

                    // Refresh token also expired → clear cookie entirely.
                    // authGuard will see no gh_token and redirect to login.
                    if (now >= session.refreshExpiresAt) {
                        setCookie(c, COOKIE_NAME, "", {
                            path: "/",
                            httpOnly: true,
                            sameSite: "Lax",
                            secure: true,
                            maxAge: 0,
                        });
                        await next();
                        return;
                    }

                    // Access token expired → refresh with rotation.
                    if (now >= session.accessExpiresAt) {
                        try {
                            const client = new GitHubClient("");
                            const result = await client.refreshAccessToken(
                                session.refreshToken,
                                c.env.GITHUB_CLIENT_ID,
                                c.env.GITHUB_CLIENT_SECRET
                            );

                            const newSession: SessionPayload = {
                                accessToken: result.accessToken,
                                refreshToken: result.refreshToken,
                                accessExpiresAt: now + result.expiresIn * 1000,
                                refreshExpiresAt:
                                    now + result.refreshTokenExpiresIn * 1000,
                            };

                            const encrypted = await encryptWith(
                                key,
                                JSON.stringify(newSession)
                            );

                            const isHttps = c.req.url.startsWith("https://");
                            setCookie(c, COOKIE_NAME, encrypted, {
                                path: "/",
                                httpOnly: true,
                                sameSite: "Lax",
                                secure: isHttps,
                                maxAge: MAX_AGE_SECS,
                            });

                            c.set("gh_token", result.accessToken);
                        } catch {
                            // Refresh failed (network error, revoked token, etc.)
                            // Clear cookie and let authGuard handle the redirect.
                            setCookie(c, COOKIE_NAME, "", {
                                path: "/",
                                httpOnly: true,
                                sameSite: "Lax",
                                secure: true,
                                maxAge: 0,
                            });
                            await next();
                            return;
                        }
                    } else {
                        c.set("gh_token", session.accessToken);
                    }
                }
            }
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
            return c.html(renderPage(<LoginPage redirectUrl={redirectUrl} />));
        }
        c.set("client", new GitHubClient(token));
        await next();
    };
}
