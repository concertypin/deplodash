import { readFile, writeFile } from "node:fs/promises";
import * as z from "zod";

const sourceConfigUrl = new URL("../wrangler.json", import.meta.url);
const generatedConfigUrl = new URL(
    "../dist/deplodash/wrangler.json",
    import.meta.url
);
const generatedConfigSchema = z
    .object({
        assets: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough();
const sourceConfigSchema = z.object({
    assets: z
        .object({
            directory: z.string(),
            binding: z.string(),
            not_found_handling: z.literal("single-page-application"),
            run_worker_first: z.literal(true),
        })
        .passthrough(),
});

const [sourceConfigText, generatedConfigText] = await Promise.all([
    readFile(sourceConfigUrl, "utf8"),
    readFile(generatedConfigUrl, "utf8"),
]);
const sourceConfig = sourceConfigSchema.parse(JSON.parse(sourceConfigText));
const generatedConfig = generatedConfigSchema.parse(
    JSON.parse(generatedConfigText)
);

generatedConfig.assets = {
    ...generatedConfig.assets,
    ...sourceConfig.assets,
    directory: "../../../web/dist",
};

await writeFile(
    generatedConfigUrl,
    `${JSON.stringify(generatedConfig, null, 2)}\n`
);
