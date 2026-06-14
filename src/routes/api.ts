import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as z from "zod";
import type { HonoEnv } from "@/types";
import { authGuard } from "@/middleware";
import { parseRepo, parsePerm } from "@/helpers";
import { TokenExpiredError } from "@/errors";

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const deleteSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    keyId: z.number().int().positive(),
});

const createRepoSchema = z.object({
    name: z
        .string()
        .min(1)
        .regex(/^[\w.-]+$/),
    private: z.boolean().default(true),
});

const successSchema = z.object({
    ok: z.boolean(),
});

const errorSchema = z.object({
    error: z.string(),
});

const createRepoResponseSchema = z.object({
    full_name: z.string(),
});

const registerSchema = z.object({
    repo: z.string().min(1, "Repository is required"),
    pubkey: z
        .string()
        .min(1, "SSH public key is required")
        .startsWith("ssh-", "Invalid SSH public key"),
    perm: z.enum(["RW", "RO"]).default("RW"),
    key_name: z.string().default("nanobot"),
});

// ─── API Routes ──────────────────────────────────────────────────────────────
// Mounted at /api — paths are relative (e.g. /api/register, /api/delete, /api/create-repo)

export const apiRouter = new Hono<HonoEnv>();

// ── Register deploy key ───────────────────────────────────────────────────

apiRouter.post(
    "/register",
    authGuard(),
    describeRoute({
        description: "Register a deploy key on a repository",
        responses: {
            200: {
                description: "Success — redirects to /register page",
            },
            400: {
                description: "Bad request",
                content: {
                    "application/json": { schema: resolver(errorSchema) },
                },
            },
        },
    }),
    validator("form", registerSchema),
    async (c) => {
        const client = c.get("client")!;
        const { repo, pubkey, perm, key_name } = c.req.valid("form");
        const parsed = parseRepo(repo);
        if (!parsed)
            return c.json(
                { error: "Invalid repo format (use owner/repo)" },
                400
            );

        const fullName = `${parsed.owner}/${parsed.repo}`;
        try {
            await client.addDeployKey(
                parsed.owner,
                parsed.repo,
                key_name || "nanobot",
                pubkey,
                parsePerm(perm)
            );
            const qs = new URL(c.req.url).search;
            const result = JSON.stringify({
                ok: `Key registered on ${fullName}`,
            });
            return c.redirect(
                `/register?${qs ? qs.slice(1) : ""}&_result=${encodeURIComponent(result)}`
            );
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/auth/github");
            }
            const msg = err instanceof Error ? err.message : String(err);
            const qs = new URL(c.req.url).search;
            const result = JSON.stringify({ error: msg });
            return c.redirect(
                `/register?${qs ? qs.slice(1) : ""}&_result=${encodeURIComponent(result)}`
            );
        }
    }
);

// ── Delete deploy key ─────────────────────────────────────────────────────

apiRouter.post(
    "/delete",
    authGuard(),
    describeRoute({
        description: "Remove a deploy key from a repository",
        responses: {
            200: {
                description: "Key removed successfully",
                content: {
                    "application/json": { schema: resolver(successSchema) },
                },
            },
            400: {
                description: "Bad request",
                content: {
                    "application/json": { schema: resolver(errorSchema) },
                },
            },
        },
    }),
    validator("json", deleteSchema),
    async (c) => {
        const client = c.get("client")!;
        const { owner, repo, keyId } = c.req.valid("json");
        try {
            await client.removeDeployKey(owner, repo, keyId);
            return c.json({ ok: true });
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/auth/github");
            }
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ error: msg }, 400);
        }
    }
);

// ── Create repository ─────────────────────────────────────────────────────

apiRouter.post(
    "/create-repo",
    authGuard(),
    describeRoute({
        description: "Create a new GitHub repository",
        responses: {
            200: {
                description: "Repository created",
                content: {
                    "application/json": {
                        schema: resolver(createRepoResponseSchema),
                    },
                },
            },
            400: {
                description: "Bad request",
                content: {
                    "application/json": { schema: resolver(errorSchema) },
                },
            },
        },
    }),
    validator("json", createRepoSchema),
    async (c) => {
        const client = c.get("client")!;
        const { name, private: isPrivate } = c.req.valid("json");
        try {
            const repo = await client.createRepo(name, isPrivate);
            return c.json({ full_name: repo.full_name });
        } catch (err: unknown) {
            if (err instanceof TokenExpiredError) {
                return c.redirect("/auth/github");
            }
            const msg = err instanceof Error ? err.message : String(err);
            return c.json({ error: msg }, 400);
        }
    }
);
