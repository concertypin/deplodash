Structure:

tests/

- tests/browser/ : Contains component and integration tests that run in a browser environment using Playwright and `vitest-browser-svelte`. It ensures Svelte components render and behave correctly in real DOM environments.
- tests/unit/ : Contains unit tests that run in a Node.js environment using Vitest. These tests focus on individual functions and modules without browser dependencies. Should be fast and isolated.

Each subdirectory should follow same structure as src/ for easy mapping between source files and tests.
