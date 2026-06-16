import { router } from "@/route";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { openAPIRouteHandler } from "hono-openapi";
import type { HonoEnv } from "@/types";
/**
 * @fileoverview
 * Main entry point — mounts logger, all routes, and OpenAPI/Scalar docs.
 */

const app = new Hono<HonoEnv>().use("*", logger()).route("/", router);

// ── OpenAPI documentation ─────────────────────────────────────────────────

app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
        documentation: {
            info: {
                title: "Deplodash API",
                version: "1.0.0",
                description:
                    "Deplodash — GitHub App Token Service. Issue scoped installation tokens for AI agents.",
            },
            servers: [],
        },
    })
);
app.get(
    "/docs",
    Scalar({
        defaultHttpClient: {
            clientKey: "fetch",
            targetKey: "js",
        },
        url: "/openapi.json",
    })
);

export default app;
