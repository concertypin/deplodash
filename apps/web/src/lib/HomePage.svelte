<script lang="ts">
    import { GithubLogoIcon } from "phosphor-svelte";
    import { client } from "@/lib/api";

    interface ConsentItem {
        repo: string;
        scopes: string;
        granted_at: string;
        granted_by?: string | undefined;
        agent_id?: string | undefined;
    }

    interface UserProfile {
        login: string;
        avatarUrl: string;
        name: string | null;
    }

    interface DashboardData {
        user: UserProfile;
        consents: ConsentItem[];
    }

    async function load(): Promise<
        { kind: "login" } | { kind: "dashboard"; data: DashboardData }
    > {
        const meRes = await client.api.user.me.$get();
        if (meRes.status === 401) return { kind: "login" };

        const user: UserProfile = await meRes.json();
        const consentsRes = await client.api.user.consents.$get();
        const consents: ConsentItem[] = consentsRes.ok
            ? (await consentsRes.json()).consents
            : [];

        return { kind: "dashboard", data: { user, consents } };
    }

    let error = $state<string | null>(null);

    async function revokeConsent(item: ConsentItem) {
        try {
            const res = await client.api.consent.revoke.$post({
                json: {
                    repo: item.repo,
                    scopes: item.scopes,
                    agent_id: item.agent_id,
                },
            });
            if (res.ok) {
                // Trigger a re-fetch by navigating in place
                window.location.reload();
            }
        } catch (e) {
            error = e instanceof Error ? e.message : "Failed to revoke";
        }
    }
</script>

{#await load()}
    <div class="min-h-screen flex items-center justify-center bg-gray-50">
        <span class="text-gray-500">Loading...</span>
    </div>
{:then result}
    {#if result.kind === "login"}
        <div
            class="min-h-screen flex flex-col items-center justify-center bg-gray-50"
        >
            <div class="max-w-md w-full px-6 text-center">
                <h1 class="text-4xl font-bold text-gray-900 mb-4">Deplodash</h1>
                <p class="text-gray-600 mb-8">
                    Token Service for AI Agents — Issue scoped GitHub
                    Installation Tokens to AI agents for git push and API
                    access.
                </p>
                <a
                    href="/auth/github"
                    class="inline-flex items-center gap-2 px-6 py-3 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium"
                >
                    <GithubLogoIcon size={20} weight="fill" />
                    Login with GitHub
                </a>
            </div>
        </div>
    {:else}
        {@const { user, consents } = result.data}
        <div class="min-h-screen bg-gray-50">
            <!-- Navbar -->
            <nav
                class="bg-gray-900 text-white px-6 py-3 flex items-center justify-between"
            >
                <div class="flex items-center gap-3">
                    <span class="text-xl font-bold">Deplodash</span>
                </div>
                <div class="flex items-center gap-3">
                    {#if user.avatarUrl}
                        <img
                            src={user.avatarUrl}
                            alt={user.login}
                            class="w-8 h-8 rounded-full"
                        />
                    {/if}
                    <span class="text-sm">{user.name ?? user.login}</span>
                    <a
                        href="/logout"
                        class="text-sm text-gray-400 hover:text-white transition-colors"
                    >
                        Logout
                    </a>
                </div>
            </nav>

            <div class="max-w-6xl mx-auto px-6 py-8">
                <!-- Welcome -->
                <div class="mb-8">
                    <h2 class="text-2xl font-bold text-gray-900">
                        Welcome, {user.name ?? user.login}
                    </h2>
                    <p class="text-gray-600 mt-1">
                        Manage your authorized repositories and agent tokens.
                    </p>
                </div>

                <!-- Quick Start -->
                <div
                    class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-8"
                >
                    <h3 class="text-lg font-semibold text-gray-900 mb-2">
                        Quick Start
                    </h3>
                    <p class="text-gray-600 text-sm mb-3">
                        Request a token for any repository by calling:
                    </p>
                    <pre
                        class="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto text-sm">
                        <code
                            >POST /api/token
&#123; "owner": "my-org", "repo": "my-repo", "agent_id": "my-agent" &#125;
Authorization: Bearer &lt;agent-token&gt;</code
                        >
                    </pre>
                </div>

                <!-- Error display -->
                {#if error}
                    <div
                        class="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6"
                    >
                        {error}
                    </div>
                {/if}

                <!-- Consents -->
                <div
                    class="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
                >
                    <h3 class="text-lg font-semibold text-gray-900 mb-4">
                        Authorized Repositories
                    </h3>

                    {#if consents.length === 0}
                        <div class="text-center py-8 text-gray-500">
                            <p class="text-lg mb-2">
                                No repositories authorized yet
                            </p>
                            <p class="text-sm">
                                Grant consent when an agent requests access to a
                                repository.
                            </p>
                        </div>
                    {:else}
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead>
                                    <tr
                                        class="border-b border-gray-200 text-sm text-gray-500"
                                    >
                                        <th class="pb-2 font-medium"
                                            >Repository</th
                                        >
                                        <th class="pb-2 font-medium">Scopes</th>
                                        <th class="pb-2 font-medium">Granted</th
                                        >
                                        <th class="pb-2 font-medium"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each consents as item}
                                        <tr class="border-b border-gray-100">
                                            <td
                                                class="py-3 text-sm font-medium text-gray-900"
                                                >{item.repo}</td
                                            >
                                            <td
                                                class="py-3 text-sm text-gray-600"
                                                >{item.scopes}</td
                                            >
                                            <td
                                                class="py-3 text-sm text-gray-500"
                                            >
                                                {new Date(
                                                    item.granted_at
                                                ).toLocaleDateString()}
                                            </td>
                                            <td class="py-3 text-right">
                                                <button
                                                    onclick={() =>
                                                        revokeConsent(item)}
                                                    class="text-sm text-red-600 hover:text-red-800 transition-colors"
                                                >
                                                    Revoke
                                                </button>
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    {/if}
                </div>

                <!-- Resources -->
                <div class="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div
                        class="bg-white rounded-lg shadow-sm border border-gray-200 p-4"
                    >
                        <h4 class="font-semibold text-gray-900 mb-1">
                            API Documentation
                        </h4>
                        <p class="text-sm text-gray-600 mb-2">
                            View the full OpenAPI specification.
                        </p>
                        <a
                            href="/docs"
                            class="text-sm text-blue-600 hover:text-blue-800"
                        >
                            Open API Docs &rarr;
                        </a>
                    </div>
                    <div
                        class="bg-white rounded-lg shadow-sm border border-gray-200 p-4"
                    >
                        <h4 class="font-semibold text-gray-900 mb-1">
                            LLM Guide
                        </h4>
                        <p class="text-sm text-gray-600 mb-2">
                            Documentation for LLM agents.
                        </p>
                        <a
                            href="/llms.txt"
                            class="text-sm text-blue-600 hover:text-blue-800"
                        >
                            View llms.txt &rarr;
                        </a>
                    </div>
                </div>
            </div>
        </div>
    {/if}
{:catch err}
    <div class="min-h-screen flex items-center justify-center bg-gray-50">
        <div class="text-red-600">Error: {err.message}</div>
    </div>
{/await}
