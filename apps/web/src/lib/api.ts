import { hc } from "hono/client";
// Import is weird and full of evil, but this is working way to get the type
import type { AppType } from "@/../../api/src/route";

/**
 * Hono RPC client — fully typed client for the deplodash API.
 * Uses relative URLs so it works on both the Worker domain and the dev proxy.
 */
export const client = hc<AppType>("");
