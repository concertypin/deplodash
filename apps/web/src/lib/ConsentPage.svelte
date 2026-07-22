<script lang="ts">
    import { client } from "@/lib/api";
    import { approvableScopeIds, scopeCategories } from "@/lib/scopes";
    import { SvelteSet } from "svelte/reactivity";

    const params = new URLSearchParams(window.location.search);
    const repo = params.get("repo") ?? "";
    const scopes = params.get("scopes") ?? "";
    const agentId = params.get("agent_id");
    const requestedScopesEnc = params.get("requested_scopes_enc");

    let selectedScopes = new SvelteSet(
        scopes
            .split(",")
            .map((s) => s.trim())
            .filter((scope) => approvableScopeIds.has(scope))
    );
    let error = $state<string | null>(null);

    function toggleScope(scope: string) {
        if (selectedScopes.has(scope)) {
            selectedScopes.delete(scope);
        } else {
            selectedScopes.add(scope);
        }
    }

    type PageState =
        | { kind: "loading" }
        | { kind: "error"; message: string }
        | { kind: "ready"; user: { login: string; avatarUrl: string } };

    let page = $state<PageState>({ kind: "loading" });

    (async () => {
        try {
            const res = await client.api.user.me.$get();
            if (res.status === 401) {
                const returnUrl = encodeURIComponent(
                    window.location.pathname + window.location.search
                );
                window.location.href = `/auth/github?next=${returnUrl}`;
                return;
            }
            if (!res.ok) {
                page = { kind: "error", message: "Authentication check failed" };
                return;
            }
            page = { kind: "ready", user: await res.json() };
        } catch (e) {
            page = { kind: "error", message: e instanceof Error ? e.message : "Authentication check failed" };
        }
    })();

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

{#if page.kind === "loading"}
    <div class="min-h-screen flex items-center justify-center bg-base-200" role="status">
        <span class="text-base-content/60">Checking authentication...</span>
    </div>
{:else if page.kind === "error"}
    <div class="min-h-screen flex items-center justify-center bg-base-200">
        <div class="text-error" role="alert">Authentication failed: {page.message}</div>
    </div>
{:else}
    <div class="min-h-screen bg-base-200">
        <nav
            class="bg-neutral text-neutral-content px-6 py-3 flex items-center justify-between"
        >
            <div class="flex items-center gap-3">
                <span class="text-xl font-bold">Deplodash</span>
            </div>
            <div class="flex items-center gap-3">
                {#if page.user.avatarUrl}
                    <img
                        src={page.user.avatarUrl}
                        alt={page.user.login}
                        class="w-8 h-8 rounded-full"
                    />
                {/if}
                <a
                    href="/logout"
                    class="text-sm text-neutral-content/60 hover:text-neutral-content transition-colors"
                >
                    Logout
                </a>
            </div>
        </nav>
    <div class="max-w-lg mx-auto px-6 py-12">
        <div class="bg-base-100 rounded-box shadow-sm border border-base-200 p-8">
            <h2 class="text-2xl font-bold text-base-content mb-2">Authorization Required</h2>
            <p class="text-base-content/70 mb-6">
                An agent wants to access repository
                <strong class="text-base-content">{repo}</strong>
                with the following permissions:
            </p>

            {#if scopes}
                <div class="mb-6" role="group" aria-label="Select permissions to grant">
                    <p class="text-sm font-semibold text-base-content/80 mb-3">Select permissions to grant:</p>
                    {#each scopeCategories as category (category.label)}
                        <fieldset class="mb-4">
                            <legend class="text-xs font-medium text-base-content/60 uppercase tracking-wider mb-2">{category.label}</legend>
                            <div class="space-y-2">
                                {#each category.scopes as scope (scope.id)}
                                    <label class="flex items-start gap-3 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={selectedScopes.has(scope.id)}
                                            onchange={() => toggleScope(scope.id)}
                                            class="checkbox checkbox-sm mt-1"
                                        />
                                        <div>
                                            <span class="text-sm font-medium text-base-content">{scope.id}</span>
                                            <p class="text-xs text-base-content/60">{scope.description}</p>
                                        </div>
                                    </label>
                                {/each}
                            </div>
                        </fieldset>
                    {/each}
                </div>
            {/if}

            {#if error}
                <div class="bg-error/10 border border-error/20 text-error rounded-box p-3 mb-4 text-sm" role="alert">
                    {error}
                </div>
            {/if}

            <div class="flex gap-3">
                <button
                    onclick={handleGrant}
                    class="btn btn-neutral flex-1"
                >
                    Grant Access
                </button>
                <button
                    onclick={handleDeny}
                    class="btn btn-ghost flex-1"
                >
                    Deny
                </button>
            </div>
        </div>
    </div>
</div>
{/if}
