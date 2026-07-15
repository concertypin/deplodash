import { router } from "@/route";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { openAPIRouteHandler } from "hono-openapi";
import type { HonoEnv } from "@/types";
import type { AppType } from "@/route";

export type { AppType };
/**
 * @fileoverview
 * Main entry point — mounts logger, all routes, and OpenAPI/Scalar docs.
 */

const apiPathPattern = /^\/api(?:\/|$)/i;

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

app.notFound((c) => {
    const pathname = c.req.path;
    if (
        apiPathPattern.test(pathname) ||
        (c.req.method !== "GET" && c.req.method !== "HEAD")
    ) {
        return c.text("Not Found", 404);
    }

    const assets = c.env.ASSETS;
    if (!assets) return c.text("Static assets binding unavailable", 500);
    return assets.fetch(c.req.raw);
});

export default app;
