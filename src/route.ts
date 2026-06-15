import type { HonoEnv } from "@/types";
import { Hono } from "hono";
import { sessionMiddleware } from "@/middleware";
import { pagesRouter } from "@/routes/pages";
import { authRouter } from "@/routes/auth";
import { oauthRouter } from "@/routes/oauth";
import { apiRouter } from "@/routes/api";
import { consentRouter } from "@/routes/consent";
import { tokenRouter } from "@/routes/token";
import { llmsRouter } from "@/routes/llms";

/**
 * Root router that composes all sub-routers.
 *
 * Mount point hierarchy:
 *   /          → pages (/, /setup, /register)
 *   /auth      → auth (OAuth start — /auth/github, /auth/consent)
 *   (root)     → oauth (/callback, /logout)
 *   /api       → API (/api/register, /api/delete, /api/create-repo, /api/token)
 *   /llms.txt  → LLM agent documentation
 *
 * sessionMiddleware (cookie decryption) is scoped only to routes that need it
 * — page routes, OAuth routes, and v1 API routes. v2 token API and /llms.txt
 * use Bearer token or no auth and don't need cookie-based sessions.
 */
export const router = new Hono<HonoEnv>()
    // Routes requiring session cookie (pages, OAuth, v1 API)
    .route(
        "/",
        new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/", pagesRouter)
            .route("/auth", authRouter)
            .route("/auth", consentRouter)
            .route("/", oauthRouter)
            .route("/api", apiRouter)
    )
    // Routes NOT requiring session cookie
    .route("/api", tokenRouter)
    .route("/", llmsRouter);
