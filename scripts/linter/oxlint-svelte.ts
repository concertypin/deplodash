import { defineConfig } from "oxlint";
export default defineConfig({
    overrides: [
        {
            files: ["**/*.svelte"],
            rules: {
                "prefer-const": "off",
                "no-unassigned-vars": "off",
            },
        },
    ],
});
