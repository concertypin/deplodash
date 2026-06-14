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
 */
export const router = new Hono<HonoEnv>()
    .use("*", sessionMiddleware())
    .route("/", pagesRouter)
    .route("/auth", authRouter)
    .route("/auth", consentRouter)
    .route("/", oauthRouter)
    .route("/api", apiRouter)
    .route("/api", tokenRouter)
    .route("/", llmsRouter);
