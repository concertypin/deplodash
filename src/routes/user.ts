/**
 * User token API — returns the authenticated GitHub user's OAuth token.
 *
 * Unlike POST /api/token (which issues a GitHub App Installation Token),
 * this endpoint returns the user's personal OAuth access token from the
 * session cookie. Operations performed with this token will appear as
 * the authenticated GitHub user (not the deplodash GitHub App).
 *
 * GET /api/user/token
 *
 * Requires a valid session cookie (set by OAuth login via /auth/github).
 * Returns 401 if not authenticated.
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import { sessionMiddleware } from "@/middleware";
import { describeRoute, resolver } from "hono-openapi";
import * as z from "zod";

const errorResponseSchema = z.object({
    error: z
        .string()
        .meta({
            description: "Error message",
            examples: ["Not authenticated"],
        }),
});

const userTokenResponseSchema = z.object({
    status: z.literal("ok").meta({ description: "Always 'ok' on success" }),
    token: z
        .string()
        .meta({
            description: "GitHub OAuth access token",
            examples: ["gho_xxxxxxxxxxxx"],
        }),
});

export const userRouter = new Hono<HonoEnv>();

userRouter.get(
    "/token",
    sessionMiddleware(),
    describeRoute({
        tags: ["User"],
        description: "Returns the authenticated GitHub user's OAuth token.",
        responses: {
            200: {
                description: "Success",
                content: {
                    "application/json": {
                        schema: resolver(userTokenResponseSchema),
                    },
                },
            },
            401: {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: resolver(errorResponseSchema),
                    },
                },
            },
        },
    }),
    (c) => {
        const token = c.get("gh_token");

        if (!token) {
            return c.json({ error: "Not authenticated" }, 401);
        }

        return c.json({
            status: "ok",
            token,
        });
    }
);
