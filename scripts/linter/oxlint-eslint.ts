import { defineConfig } from "oxlint";

import eslintErrorConfig from "./oxlint-eslint-error.ts";
import eslintWarnConfig from "./oxlint-eslint-warn.ts";
export default defineConfig({
    extends: [eslintErrorConfig, eslintWarnConfig],
    overrides: [
        {
            // Config file can't be aliased by tsconfig or vite,
            // so we have to use relative path here.
            files: ["./*.mjs", "./*.ts", "./scripts/**/*.ts", "./apps/web/*.ts", "./apps/web/scripts/**/*.ts"],
            rules: {
                "import/no-relative-parent-imports": "off",
            }
        }
    ]
});
