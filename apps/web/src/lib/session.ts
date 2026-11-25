/**
 * Signed-in user helpers shared by the consent pages.
 *
 * Plain TS (no framework code) so the pages stay thin.
 */

import { client } from "@/lib/api";

export type SignedInUser = { login: string; avatarUrl: string };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null) return null;
    return Object.fromEntries(Object.entries(value));
}

export function isSignedInUser(value: unknown): value is SignedInUser {
    const candidate = asRecord(value);
    return (
        typeof candidate?.login === "string" &&
        typeof candidate.avatarUrl === "string"
    );
}

/** The `error` string of an API error body, or null. */
export function apiErrorMessage(value: unknown): string | null {
    const candidate = asRecord(value);
    return typeof candidate?.error === "string" ? candidate.error : null;
}

/** Send the browser to GitHub login, returning to the current page afterwards. */
export function redirectToLogin(): void {
    const returnUrl = encodeURIComponent(
        window.location.pathname + window.location.search
    );
    window.location.href = `/auth/github?next=${returnUrl}`;
}

/**
 * Load the signed-in user. Not signed in: redirects to login and returns
 * "redirected". A malformed answer returns null.
 */
export async function loadSignedInUser(): Promise<
    SignedInUser | "redirected" | null
> {
    const res = await client.api.user.me.$get();
    if (res.status === 401) {
        redirectToLogin();
        return "redirected";
    }
    const data: unknown = await res.json();
    return res.ok && isSignedInUser(data) ? data : null;
}
