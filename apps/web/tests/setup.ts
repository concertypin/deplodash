// Initialize vitest-browser-svelte to expose `render`/`cleanup` helpers
if (import.meta.env.VITEST_BROWSER) await import("vitest-browser-svelte");

// Keep this file minimal — heavy setup slows tests. Add mocks/helpers here as needed.
