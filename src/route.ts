import type { HonoEnv } from "@/types";
import { Hono } from "hono";
import { sessionMiddleware } from "@/middleware";
import { pagesRouter } from "@/routes/pages";
import { authRouter } from "@/routes/auth";
import { oauthRouter } from "@/routes/oauth";
import { apiRouter } from "@/routes/api";

/**
 * Root router that composes all sub-routers.
 *
 * Mount point hierarchy:
 *   /          → pages (/, /setup, /register)
 *   /auth      → auth (OAuth start — /auth/github)
 *   (root)     → oauth (/callback, /logout)
 *   /api       → API (/api/register, /api/delete, /api/create-repo)
 */
export const router = new Hono<HonoEnv>()
    .use("*", sessionMiddleware())
    .route("/", pagesRouter)
    .route("/auth", authRouter)
    .route("/", oauthRouter)
    .route("/api", apiRouter);
