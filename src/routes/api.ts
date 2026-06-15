/**
 * API routes (v1) — removed.
 *
 * The v1 deploy key management API (register, delete, create-repo) has been
 * removed. All token issuance is now handled by the v2 GitHub App Token Service
 * via POST /api/token (see token.ts), with auto-repo-creation support.
 */

import { Hono } from "hono";
import type { HonoEnv } from "@/types";

export const apiRouter = new Hono<HonoEnv>();
