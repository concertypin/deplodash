/**
 * Home page (dashboard) component.
 * Shows user info, quick start guide, consent list with revoke, and resources.
 */

import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { Navbar } from "./Navbar";
import { Sidebar } from "./Sidebar";

export interface ConsentItem {
    repo: string;
    scopes: string;
    granted_at: string;
    granted_by?: string;
}

interface HomePageProps {
    login: string;
    avatarUrl: string;
    consents: ConsentItem[];
}

const HomePage: FC<HomePageProps> = ({ login, avatarUrl, consents }) => (
    <Layout title="Deplodash — Token Service">
        <div class="drawer lg:drawer-open">
            <input id="drawer" type="checkbox" class="drawer-toggle" />
            <div class="drawer-content flex flex-col">
                <Navbar login={login} avatarUrl={avatarUrl} />

                <div class="p-8 max-w-2xl mx-auto space-y-6">
                    {/* Hero */}
                    <div class="hero">
                        <div class="hero-content text-center p-0">
                            <div class="max-w-lg">
                                <div class="mb-4">
                                    <i
                                        data-lucide="bot"
                                        class="w-16 h-16 mx-auto text-primary"
                                    />
                                </div>
                                <h1 class="text-3xl font-bold">Deplodash</h1>
                                <p class="text-base-content/60 mt-2">
                                    GitHub App Token Service — issue scoped
                                    installation tokens for AI agents.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div class="divider" />

                    {/* Quick Start */}
                    <div class="space-y-3">
                        <h2 class="text-xl font-semibold">Quick Start</h2>
                        <div class="bg-base-200 rounded-box p-4">
                            <p class="text-sm text-base-content/70 mb-3">
                                Agents request tokens via the API. You manage
                                consent for repositories.
                            </p>
                            <div class="text-sm space-y-2 font-mono">
                                <div class="bg-base-300 rounded p-3">
                                    <div class="text-xs text-base-content/50 mb-1">
                                        Request a token
                                    </div>
                                    <pre>
                                        {`POST /api/token\nAuthorization: Bearer <agent_token>\n{"repo": "owner/repo", "scopes": ["contents:write"]}`}
                                    </pre>
                                </div>
                                <div class="bg-base-300 rounded p-3">
                                    <div class="text-xs text-base-content/50 mb-1">
                                        Response
                                    </div>
                                    <pre>
                                        {`{"status": "ok", "token": "ghs_...", "expires_at": "..."}`}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Consent List */}
                    <ConsentList consents={consents} />

                    {/* Resources */}
                    <div class="space-y-3">
                        <h2 class="text-xl font-semibold">Resources</h2>
                        <ul class="menu bg-base-200 rounded-box p-2">
                            <li>
                                <a href="/llms.txt" class="gap-2">
                                    <i
                                        data-lucide="file-text"
                                        class="w-4 h-4"
                                    />
                                    Agent Guide (/llms.txt)
                                </a>
                            </li>
                            <li>
                                <a href="/docs" class="gap-2">
                                    <i
                                        data-lucide="book-open"
                                        class="w-4 h-4"
                                    />
                                    API Docs (Scalar)
                                </a>
                            </li>
                            <li>
                                <a href="/openapi.json" class="gap-2">
                                    <i data-lucide="code" class="w-4 h-4" />
                                    OpenAPI Spec
                                </a>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            <div class="drawer-side">
                <label for="drawer" class="drawer-overlay" />
                <Sidebar />
            </div>
        </div>
    </Layout>
);

export default HomePage;

// ─── Consent List Component ─────────────────────────────────────────────────

const ConsentList: FC<{ consents: ConsentItem[] }> = ({ consents }) => (
    <div class="space-y-3">
        <h2 class="text-xl font-semibold">Authorized Repositories</h2>
        {consents.length === 0 ? (
            <div class="bg-base-200 rounded-box p-6 text-center">
                <p class="text-base-content/50">
                    <i data-lucide="shield-off" class="w-8 h-8 mx-auto mb-2" />
                </p>
                <p class="text-sm text-base-content/60">
                    No consents granted yet. When an agent requests access to a
                    repository, you'll need to approve it via the consent page
                    before a token can be issued.
                </p>
            </div>
        ) : (
            <div class="overflow-x-auto">
                <table class="table table-zebra">
                    <thead>
                        <tr>
                            <th>Repository</th>
                            <th>Scopes</th>
                            <th>Granted By</th>
                            <th>Granted</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {consents.map((item) => (
                            <ConsentRow
                                key={item.repo + item.scopes}
                                item={item}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        )}
    </div>
);

const ConsentRow: FC<{ item: ConsentItem }> = ({ item }) => {
    const grantedDate = new Date(item.granted_at).toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

    return (
        <tr>
            <td class="font-mono text-sm">{item.repo}</td>
            <td>
                <div class="flex flex-wrap gap-1">
                    {item.scopes.split(",").map((s, i) => (
                        <span key={i} class="badge badge-sm badge-primary">
                            {s.trim()}
                        </span>
                    ))}
                </div>
            </td>
            <td class="text-sm text-base-content/60">
                {item.granted_by ?? (
                    <span class="text-base-content/40">&mdash;</span>
                )}
            </td>
            <td class="text-sm text-base-content/60">{grantedDate}</td>
            <td>
                <form
                    method="post"
                    action="/auth/revoke"
                    onsubmit="return confirm('Revoke access for this repository?')"
                >
                    <input type="hidden" name="repo" value={item.repo} />
                    <input type="hidden" name="scopes" value={item.scopes} />
                    <button type="submit" class="btn btn-error btn-xs gap-1">
                        <i data-lucide="x-circle" class="w-3 h-3" />
                        Revoke
                    </button>
                </form>
            </td>
        </tr>
    );
};
