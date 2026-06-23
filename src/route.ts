import type { HonoEnv } from "@/types";
import { Hono } from "hono";
import { sessionMiddleware } from "@/middleware";
import { pagesRouter } from "@/routes/pages";
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
 *   /          → pages (/)
 *   /auth      → auth (OAuth start — /auth/github, /auth/consent)
 *   (root)     → oauth (/callback, /logout)
 *   /api       → API (/api/token)
 *   /api/user  → User API (/api/user/token)
 *   /api/admin → Admin API (/api/admin/agent/list)
 *   /llms.txt  → LLM agent documentation
 *
 * sessionMiddleware (cookie decryption) is scoped only to routes that need it
 * — page routes, OAuth routes, admin routes, and user routes. token API and
 * /llms.txt use Bearer token or no auth and don't need cookie-based sessions.
 */
export const router = new Hono<HonoEnv>()
    // Routes requiring session cookie (pages, OAuth, admin)
    .route(
        "/",
        new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/", pagesRouter)
            .route("/auth", authRouter)
            .route("/auth", consentRouter)
            .route("/", oauthRouter)
            .route("/api/admin", adminRouter)
    )
    // Routes NOT requiring session cookie
    .route("/api", tokenRouter)
    .route("/api/user", userRouter)
    .route("/", llmsRouter);
