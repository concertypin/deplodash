/**
 * Consent page component — User-facing page for approving agent token requests.
 */

import type { FC } from "hono/jsx";
import { Layout } from "./Layout";

const SCOPE_LABELS: Record<string, string> = {
    "contents:read": "Read repository contents",
    "contents:write": "Read & write repository contents",
    "workflows:write": "Read & write workflow files",
    admin: "Full admin access",
};

interface ConsentPageProps {
    repo: string;
    scopes: string;
    error?: string;
    success?: boolean;
}

export const ConsentPage: FC<ConsentPageProps> = ({
    repo,
    scopes,
    error,
    success,
}) => {
    const scopeList = scopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    return (
        <Layout title={`Authorize Agent — ${repo}`}>
            <div class="hero min-h-screen">
                <div class="hero-content w-full max-w-lg">
                    <div class="card bg-base-200 shadow-xl w-full">
                        <div class="card-body">
                            <h2 class="card-title mb-2">
                                🔑 Authorize Agent Access
                            </h2>
                            <p class="text-sm text-base-content/60 mb-4">
                                An agent is requesting access to a repository.
                                Review the details below.
                            </p>

                            {error && (
                                <div class="alert alert-error mb-4">
                                    <span>{error}</span>
                                </div>
                            )}

                            {success && (
                                <div class="alert alert-success mb-4">
                                    <span>
                                        ✅ Consent recorded. The agent can now
                                        request tokens.
                                    </span>
                                </div>
                            )}

                            <div class="bg-base-300 rounded-lg p-4 mb-4">
                                <div class="font-semibold mb-1">Repository</div>
                                <div class="font-mono text-sm">{repo}</div>
                                <div class="font-semibold mt-3 mb-1">
                                    Requested Permissions
                                </div>
                                <div class="text-sm">
                                    {scopeList.map((s, i) => (
                                        <div key={i}>
                                            • {SCOPE_LABELS[s] ?? s}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {!success ? (
                                <form method="post" action="/auth/consent">
                                    <input
                                        type="hidden"
                                        name="repo"
                                        value={repo}
                                    />
                                    <input
                                        type="hidden"
                                        name="scopes"
                                        value={scopes}
                                    />
                                    <div class="card-actions justify-end">
                                        <a href="/" class="btn btn-ghost">
                                            Deny
                                        </a>
                                        <button
                                            type="submit"
                                            class="btn btn-primary"
                                        >
                                            Confirm
                                        </button>
                                    </div>
                                </form>
                            ) : (
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
