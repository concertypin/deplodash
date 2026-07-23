/* @vite-ignore */
/**
 * Minimal History API router for the deplodash SPA.
 *
 * Exports a reactive `route` object (with `.current` pathname) and a `navigate()` function.
 * Svelte 5 tracks `route.current` reactively in `.svelte` files.
 */

export const route = $state({ current: window.location.pathname });

/** Navigate to a path without a full page reload. */
export function navigate(path: string): void {
	history.pushState(null, "", path);
	route.current = path;
}

// Listen for browser back/forward
if (typeof window !== "undefined") {
	window.addEventListener("popstate", () => {
		route.current = window.location.pathname;
	});
}
