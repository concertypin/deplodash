import type { HonoEnv } from "@/types";
import { Hono } from "hono";
import { sessionMiddleware } from "@/middleware";
import { authRouter } from "@/routes/auth";
import { oauthRouter } from "@/routes/oauth";
import { consentRouter } from "@/routes/consent";
import { tokenRouter } from "@/routes/token";
import { userRouter } from "@/routes/user";
import { llmsRouter } from "@/routes/llms";
import { wellKnownRouter } from "@/routes/well-known";

/**
 * Root router that composes all sub-routers.
 *
 * Mount point hierarchy:
 *   /auth      → auth (OAuth start — /auth/github)
 *   /api       → API token (/api/token)
 *   /api/consent    → Consent API (/api/consent, /api/consent/revoke)
 *   /llms.txt  → LLM agent documentation
 *   /.well-known → OIDC discovery + JWKS (Workload Identity Federation)
 *
 * — OAuth routes, consent routes, and user routes. token API and
 * /llms.txt use Bearer token or no auth and don't need cookie-based sessions.
 *
 * Note: the session sub-app's `use("*")` is registered on this router as
 * `/*`, so it also runs for every route mounted after it. /.well-known is
 * mounted first so relying parties fetching discovery/JWKS never go through
 * session decryption or emit `Set-Cookie` on a publicly cached response.
 */
export const router = new Hono<HonoEnv>()
    // Public OIDC metadata — must stay ahead of the session middleware.
    .route("/", wellKnownRouter)
    // Routes requiring session cookie (OAuth, consent, user)
    .route(
        "/",
        new Hono<HonoEnv>()
            .use("*", sessionMiddleware())
            .route("/auth", authRouter)
            .route("/", oauthRouter)
            .route("/api/consent", consentRouter)
            .route("/api/user", userRouter)
    )
    // Routes NOT requiring session cookie
    .route("/api", tokenRouter)
    .route("/", llmsRouter);

export type AppType = typeof router;
