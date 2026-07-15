import type { HonoEnv } from "@/types";
import { Hono } from "hono";
import { sessionMiddleware } from "@/middleware";
import { authRouter } from "@/routes/auth";
import { oauthRouter } from "@/routes/oauth";
import { consentRouter } from "@/routes/consent";
import { tokenRouter } from "@/routes/token";
import { userRouter } from "@/routes/user";
import { adminRouter } from "@/routes/admin";
import { llmsRouter } from "@/routes/llms";

/**
 * Root router that composes all sub-routers.
 *
 * Mount point hierarchy:
 *   /auth      → auth (OAuth start — /auth/github)
 *   /api       → API token (/api/token)
 *   /api/user  → User API (/api/user/me, /api/user/consents, /api/user/token)
 *   /api/consent    → Consent API (/api/consent, /api/consent/revoke)
 *   /api/admin → Admin API (/api/admin/agent/list)
 *   (root)     → oauth (/callback, /logout)
 *   /llms.txt  → LLM agent documentation
 *
 * sessionMiddleware (cookie decryption) is scoped only to routes that need it
 * — OAuth routes, admin routes, consent routes, and user routes. token API and
 * /llms.txt use Bearer token or no auth and don't need cookie-based sessions.
 */
export const router = new Hono<HonoEnv>()
    // Routes requiring session cookie (OAuth, admin, consent, user)
    .route(
        "/",
        new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", authRouter)
            .route("/", oauthRouter)
            .route("/api/admin", adminRouter)
            .route("/api/consent", consentRouter)
            .route("/api/user", userRouter)
    )
    // Routes NOT requiring session cookie
    .route("/api", tokenRouter)
    .route("/", llmsRouter);

export type AppType = typeof router;
