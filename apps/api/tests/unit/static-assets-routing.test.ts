import { describe, expect, it } from "vitest";
import * as z from "zod";
import workerConfigText from "@root/apps/api/wrangler.json?raw";

const workerConfigSchema = z.object({
    assets: z.looseObject({
        directory: z.literal("../web/dist"),
        binding: z.literal("ASSETS"),
        not_found_handling: z.literal("single-page-application"),
        run_worker_first: z.literal(true),
    }),
});

describe("Cloudflare static asset routing", () => {
    it("runs the Worker before serving navigation assets", () => {
        const config = workerConfigSchema.parse(JSON.parse(workerConfigText));

        expect(config.assets).toMatchObject({
            directory: "../web/dist",
            binding: "ASSETS",
            not_found_handling: "single-page-application",
            run_worker_first: true,
        });
    });
});
