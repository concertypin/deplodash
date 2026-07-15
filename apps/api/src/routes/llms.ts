/**
 * LLMs route — Agent documentation for Deplodash GitHub App Token API.
 *
 * Served at GET /llms.txt so any agent can discover how to authenticate,
 * request tokens, configure Git credential helpers, and handle permission
 * elevation.
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";
import LLMS_CONTENT from "@/routes/llms.txt.md?raw";
// ─── Routes ──────────────────────────────────────────────────────────────────
// Mounted at / — paths are relative

export const llmsRouter = new Hono<HonoEnv>().get("/llms.txt", (c) => {
    const url = new URL(c.req.url);
    const base = `${url.protocol}//${url.host}`;
    const content = LLMS_CONTENT.replaceAll("{{BASE}}", base);
    return c.text(content, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
    });
});
