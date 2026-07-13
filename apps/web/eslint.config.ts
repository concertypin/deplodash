import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import { defineConfig } from "eslint/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import oxlint from "eslint-plugin-oxlint";

import svelteConfig from "./svelte.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isCI = process.env.CI ? true : false;

const oxlintize = true;

export default defineConfig([
    {
        ignores: ["dist/", "node_modules/", "*.config.*", "coverage/"],
    },
    {
        files: ["**/*.svelte", "**/*.svelte.ts"],
        extends: [
            js.configs.recommended,
            ...ts.configs.recommendedTypeChecked,
            ...svelte.configs["flat/recommended"],
        ],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: __dirname,
                extraFileExtensions: [".svelte"],
            },
        },
    },

    {
        files: ["**/*.svelte", "**/*.svelte.ts"],
        languageOptions: {
            parserOptions: {
                parser: ts.parser,
                svelteConfig: svelteConfig,
            },
        },
    },
    {
        files: ["**/*.svelte", "**/*.svelte.ts"],
        rules: {
            "svelte/require-store-reactive-access": "off",
            "no-restricted-syntax": [
                "error",
                {
                    selector:
                        "CallExpression[callee.name=/^(writable|readable)$/]",
                    message:
                        "Direct use of 'writable' or 'readable' is discouraged in Svelte 5. You should use Runes instead.",
                },
            ],
            "svelte/block-lang": ["error", { script: "ts" }],
        },
    },
    {
        files: ["**/*.svelte", "**/*.svelte.ts"],
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/unbound-method": "off",
            "svelte/no-useless-children-snippet": "warn",
            "no-debugger": isCI ? "error" : "warn",
            "no-console": "warn",
        },
    },

    ...(oxlintize
        ? oxlint
              .buildFromOxlintConfigFile(".oxlintrc.json", {
                  typeAware: true,
              })
              .map((config) => ({
                  ...config,
                  files: ["**/*.svelte", "**/*.svelte.ts"],
              }))
        : []),
]);
