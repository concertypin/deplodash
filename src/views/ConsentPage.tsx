/**
 * Consent page component — User-facing page for approving agent token requests.
 *
 * Supports granular permission selection: the user can approve or deny
 * each requested scope individually via checkboxes.
 */

import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { SCOPE_CATEGORIES, SCOPE_LABELS } from "@/github/scopes";

interface ConsentPageProps {
    repo: string;
    scopes: string;
    error?: string;
    success?: boolean;
    agentId?: string;
    /** Encrypted requested scopes — prevents client-side tampering of the hidden field. */
    requestedScopesEnc?: string;
}

/**
 * Group scopes by their category for display.
 */
function categorizedScopes(scopeList: string[]) {
    const categories: {
        label: string;
        scopes: { scope: string; label: string }[];
    }[] = [];
    const seen = new Set<string>();

    for (const [, cat] of Object.entries(SCOPE_CATEGORIES)) {
        const matching = cat.scopes.filter((s) => scopeList.includes(s));
        if (matching.length === 0) continue;
        categories.push({
            label: cat.label,
            scopes: matching.map((s) => ({
                scope: s,
                label: SCOPE_LABELS[s] ?? s,
            })),
        });
        matching.forEach((s) => seen.add(s));
    }

    // Any scopes not in known categories (legacy like "admin", "contents:write+workflows:write")
    const uncategorized = scopeList.filter((s) => !seen.has(s));
    if (uncategorized.length > 0) {
        categories.push({
            label: "Other",
            scopes: uncategorized.map((s) => ({
                scope: s,
                label: SCOPE_LABELS[s] ?? s,
            })),
        });
    }

    return categories;
}

export const ConsentPage: FC<ConsentPageProps> = ({
    repo,
    scopes,
    error,
    success,
    agentId,
    requestedScopesEnc,
}) => {
    const scopeList = scopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const categories = categorizedScopes(scopeList);

    return (
        <Layout title={`Authorize Agent — ${repo}`}>
            <div class="hero min-h-screen">
                <div class="hero-content w-full max-w-xl">
                    <div class="card bg-base-200 shadow-xl w-full">
                        <div class="card-body">
                            <h2 class="card-title mb-2">
                                🔑 Authorize Agent Access
                            </h2>
                            <p class="text-sm text-base-content/60 mb-2">
                                An agent is requesting access to
                                <span class="font-mono font-semibold ml-1">
                                    {repo}
                                </span>
                                . Select the permissions you want to grant, then
                                confirm.
                            </p>
                            {agentId && (
                                <div class="bg-base-300 rounded-lg p-3 mb-4 flex items-center gap-2">
                                    <i
                                        data-lucide="bot"
                                        class="w-4 h-4 text-primary"
                                    />
                                    <span class="text-sm">
                                        Agent:{" "}
                                        <span class="font-mono font-semibold">
                                            {agentId}
                                        </span>
                                    </span>
                                </div>
                            )}

                            {error && (
                                <div class="alert alert-error mb-4">
                                    <span>{error}</span>
                                </div>
                            )}

                            {success && (
                                <div class="alert alert-success mb-4">
                                    <span>
                                        ✅ Consent recorded. The agent can now
                                        request tokens with the approved
                                        permissions.
                                    </span>
                                </div>
                            )}

                            {!success && (
                                <form
                                    method="post"
                                    action="/auth/consent"
                                    id="consent-form"
                                >
                                    <input
                                        type="hidden"
                                        name="repo"
                                        value={repo}
                                    />
                                    <input
                                        type="hidden"
                                        name="requested_scopes"
                                        value={scopes}
                                    />
                                    {requestedScopesEnc && (
                                        <input
                                            type="hidden"
                                            name="requested_scopes_enc"
                                            value={requestedScopesEnc}
                                        />
                                    )}
                                    {agentId && (
                                        <input
                                            type="hidden"
                                            name="agent_id"
                                            value={agentId}
                                        />
                                    )}

                                    <div class="bg-base-300 rounded-lg p-4 mb-4">
                                        <div class="font-semibold mb-3">
                                            Requested Permissions
                                        </div>
                                        {categories.map((cat, ci) => (
                                            <div key={ci} class="mb-3">
                                                <div class="text-sm font-medium text-base-content/70 mb-1">
                                                    {cat.label}
                                                </div>
                                                {cat.scopes.map((s) => (
                                                    <label class="label cursor-pointer justify-start gap-3 py-1">
                                                        <input
                                                            type="checkbox"
                                                            name="scopes"
                                                            value={s.scope}
                                                            checked
                                                            class="checkbox checkbox-sm checkbox-primary"
                                                        />
                                                        <span class="label-text text-sm">
                                                            {s.label}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        ))}
                                    </div>

                                    <div class="card-actions justify-end">
                                        <a href="/" class="btn btn-ghost">
                                            Deny All
                                        </a>
                                        <button
                                            type="submit"
                                            class="btn btn-primary"
                                            onclick="
                                                const checked = document.querySelectorAll('input[name=\\'scopes\\']:checked');
                                                if (checked.length === 0) {
                                                    alert('Select at least one permission or click Deny.');
                                                    return false;
                                                }
                                            "
                                        >
                                            Approve Selected
                                        </button>
                                    </div>
                                </form>
                            )}

                            {success && (
                                <div class="card-actions justify-end">
                                    <a href="/" class="btn btn-primary">
                                        Back to Dashboard
                                    </a>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
};
