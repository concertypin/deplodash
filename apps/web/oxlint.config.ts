import { defineConfig } from "oxlint";
import eslintConfig from "../../scripts/linter/oxlint-eslint.ts";
import svelteConfig from "../../scripts/linter/oxlint-svelte.ts";

export default defineConfig({
    plugins: ["typescript", "unicorn", "import", "vitest", "promise"],
    env: {
        builtin: true,
    },
    ignorePatterns: [
        "**/node_modules/**",
        "**/dist/**",
        "**/dist-ts/**",
        "**/coverage/**",
        "**/.cache/**",
        "**/.vscode/**",
        "**/.git/**",
    ],
    overrides: [
        {
            files: ["**/*.d.ts"],
            rules: {
                "no-unused-vars": "off",
            },
        },
    ],
    extends: [eslintConfig, svelteConfig],
    options: {
        denyWarnings: true,
        maxWarnings: 0,
        reportUnusedDisableDirectives: "error",
        typeCheck: true,
        typeAware: true,
    },
});
