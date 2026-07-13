<script lang="ts">
    import { client } from "@/lib/api";
    import { scopeCategories } from "@/lib/scopes";
    import { SvelteSet } from "svelte/reactivity";

    const params = new URLSearchParams(window.location.search);
    const repo = params.get("repo") ?? "";
    const scopes = params.get("scopes") ?? "";
    const agentId = params.get("agent_id");
    const requestedScopesEnc = params.get("requested_scopes_enc");

    let initialScopes = $derived(scopes.split(",").map((s) => s.trim()).filter(Boolean));
    let selectedScopes = $state(new SvelteSet(initialScopes));
    let error = $state<string | null>(null);

    function toggleScope(scope: string) {
        if (selectedScopes.has(scope)) {
            selectedScopes.delete(scope);
        } else {
            selectedScopes.add(scope);
        }
    }

    async function checkAuth(): Promise<{ login: string; avatarUrl: string }> {
        const res = await client.api.user.me.$get();
        if (res.status === 401) {
            const returnUrl = encodeURIComponent(
                window.location.pathname + window.location.search
            );
            window.location.href = `/auth/github?next=${returnUrl}`;
            // never resolves — page is navigating away
            return new Promise(() => {});
        }
        const data = await res.json();
        return data;
    }

    async function handleGrant() {
        error = null;
        const scopeList = Array.from(selectedScopes);

        try {
            const res = await client.api.consent.$post({
                json: {
                    repo,
                    scopes: scopeList.join(","),
                    requested_scopes: scopes,
                    requested_scopes_enc: requestedScopesEnc ?? undefined,
                    agent_id: agentId ?? undefined,
                },
            });
            const data = await res.json();
            if (res.ok) {
                window.location.href = "/";
            } else if ("error" in data) {
                error = data.error;
            }
        } catch (e) {
            error = e instanceof Error ? e.message : "Failed to submit consent";
        }
    }

    function handleDeny() {
        window.location.href = "/";
    }
</script>

{#await checkAuth()}
    <div class="min-h-screen flex items-center justify-center bg-gray-50">
        <span class="text-gray-500">Checking authentication...</span>
    </div>
{:then user}
    <div class="min-h-screen bg-gray-50">
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
                <span class="text-sm">{user.login}</span>
                <a
                    href="/logout"
                    class="text-sm text-gray-400 hover:text-white transition-colors"
                >
                    Logout
                </a>
            </div>
        </nav>

        <div class="max-w-lg mx-auto px-6 py-12">
            <div
                class="bg-white rounded-lg shadow-sm border border-gray-200 p-8"
            >
                <h2 class="text-2xl font-bold text-gray-900 mb-2">
                    Authorization Required
                </h2>
                <p class="text-gray-600 mb-6">
                    An agent wants to access repository
                    <strong class="text-gray-900">{repo}</strong>
                    with the following permissions:
                </p>

                {#if scopes}
                    <div class="mb-6">
                        <p class="text-sm font-semibold text-gray-700 mb-3">
                            Select permissions to grant:
                        </p>
                        {#each scopeCategories as category}
                            <div class="mb-4">
                                <p
                                    class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2"
                                >
                                    {category.label}
                                </p>
                                <div class="space-y-2">
                                    {#each category.scopes as scope}
                                        <label
                                            class="flex items-start gap-3 cursor-pointer"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedScopes.has(scope.id)}
                                                onchange={() =>
                                                    toggleScope(scope.id)}
                                                class="mt-1 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                                            />
                                            <div>
                                                <span
                                                    class="text-sm font-medium text-gray-900"
                                                    >{scope.id}</span
                                                >
                                                <p
                                                    class="text-xs text-gray-500"
                                                >
                                                    {scope.description}
                                                </p>
                                            </div>
                                        </label>
                                    {/each}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}

                {#if error}
                    <div
                        class="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm"
                    >
                        {error}
                    </div>
                {/if}

                <div class="flex gap-3">
                    <button
                        onclick={handleGrant}
                        class="flex-1 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors font-medium"
                    >
                        Grant Access
                    </button>
                    <button
                        onclick={handleDeny}
                        class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors font-medium"
                    >
                        Deny
                    </button>
                </div>
            </div>
        </div>
    </div>
{:catch err}
    <div class="min-h-screen flex items-center justify-center bg-gray-50">
        <div class="text-red-600">Authentication failed: {err.message}</div>
    </div>
{/await}
