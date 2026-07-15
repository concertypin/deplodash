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

    const route = `POST /api/token\n{ "owner": "my-org", "repo": "my-repo", "agent_id": "my-agent" }\nAuthorization: Bearer <agent-token>`;

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
    <div
        class="min-h-screen flex items-center justify-center bg-base-200"
        role="status"
    >
        <span class="text-base-content/60">Loading...</span>
    </div>
{:then result}
    {#if result.kind === "login"}
        <div
            class="min-h-screen flex flex-col items-center justify-center bg-base-200"
        >
            <div class="max-w-md w-full px-6 text-center">
                <h1 class="text-4xl font-bold text-base-content mb-4">
                    Deplodash
                </h1>
                <p class="text-base-content/70 mb-8">
                    Token Service for AI Agents — Issue scoped GitHub
                    Installation Tokens to AI agents for git push and API
                    access.
                </p>
                <a href="/auth/github" class="btn btn-neutral">
                    <GithubLogoIcon size={20} weight="fill" />
                    Login with GitHub
                </a>
            </div>
        </div>
    {:else}
        {@const { user, consents } = result.data}
        <div class="min-h-screen bg-base-200">
            <!-- Navbar -->
            <nav
                class="bg-neutral text-neutral-content px-6 py-3 flex items-center justify-between"
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
                        class="text-sm text-neutral-content/60 hover:text-neutral-content transition-colors"
                    >
                        Logout
                    </a>
                </div>
            </nav>

            <div class="max-w-6xl mx-auto px-6 py-8">
                <!-- Welcome -->
                <div class="mb-8">
                    <h2 class="text-2xl font-bold text-base-content">
                        Welcome, {user.name ?? user.login}
                    </h2>
                    <p class="text-base-content/70 mt-1">
                        Manage your authorized repositories and agent tokens.
                    </p>
                </div>

                <!-- Quick Start -->
                <div
                    class="bg-base-100 rounded-box shadow-sm border border-base-200 p-6 mb-8"
                >
                    <h3 class="text-lg font-semibold text-base-content mb-2">
                        Quick Start
                    </h3>
                    <p class="text-base-content/70 text-sm mb-3">
                        Request a token for any repository by calling:
                    </p>
                    <pre class="bg-neutral text-neutral-content rounded-box p-4 overflow-x-auto text-sm"><code>{route}</code></pre>
                </div>
                {#if error}
                    <div
                        class="bg-error/10 border border-error/20 text-error rounded-box p-4 mb-6"
                        role="alert"
                    >
                        {error}
                    </div>
                {/if}

                <!-- Consents -->
                <div
                    class="bg-base-100 rounded-box shadow-sm border border-base-200 p-6"
                >
                    <h3 class="text-lg font-semibold text-base-content mb-4">
                        Authorized Repositories
                    </h3>

                    {#if consents.length === 0}
                        <div class="text-center py-8 text-base-content/60">
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
                            <table class="table">
                                <thead>
                                    <tr>
                                        <th>Repository</th>
                                        <th>Scopes</th>
                                        <th>Granted</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                    {#each consents as item (item.repo + "|" + (item.agent_id ?? "") + "|" + item.granted_at)}
                                        <tr>
                                            <td class="font-medium"
                                                >{item.repo}</td
                                            >
                                            <td>{item.scopes}</td>
                                            <td>
                                                {new Date(
                                                    item.granted_at
                                                ).toLocaleDateString()}
                                            </td>
                                            <td class="text-right">
                                                <button
                                                    onclick={() =>
                                                        revokeConsent(item)}
                                                    class="text-error hover:text-error/80 transition-colors"
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
                        class="bg-base-100 rounded-box shadow-sm border border-base-200 p-4"
                    >
                        <h4 class="font-semibold text-base-content mb-1">
                            API Documentation
                        </h4>
                        <p class="text-sm text-base-content/70 mb-2">
                            View the full OpenAPI specification.
                        </p>
                        <a
                            href="/docs"
                            class="text-sm text-primary hover:text-primary/80"
                        >
                            Open API Docs &rarr;
                        </a>
                    </div>
                    <div
                        class="bg-base-100 rounded-box shadow-sm border border-base-200 p-4"
                    >
                        <h4 class="font-semibold text-base-content mb-1">
                            LLM Guide
                        </h4>
                        <p class="text-sm text-base-content/70 mb-2">
                            Documentation for LLM agents.
                        </p>
                        <a
                            href="/llms.txt"
                            class="text-sm text-primary hover:text-primary/80"
                        >
                            View llms.txt &rarr;
                        </a>
                    </div>
                </div>
            </div>
        </div>
    {/if}
{:catch err}
    <div class="min-h-screen flex items-center justify-center bg-base-200">
        <div class="text-error" role="alert">Error: {err.message}</div>
    </div>
{/await}
