<script lang="ts">
    import { client } from "@/lib/api";
    import { approvableScopeIds, scopeCategories, expandCompoundScopes } from "@/lib/scopes";
    import { SvelteSet } from "svelte/reactivity";

    type RepositoryMode = "existing-only" | "create-if-missing";
    type ConsentRequest = {
        repo: string;
        agent_id: string;
        scopes: string[];
        repo_mode: RepositoryMode;
    };

    function isUser(value: unknown): value is { login: string; avatarUrl: string } {
        if (typeof value !== "object" || value === null) return false;
        const candidate = Object.fromEntries(Object.entries(value));
        return (
            typeof candidate.login === "string" &&
            typeof candidate.avatarUrl === "string"
        );
    }

    function isConsentError(value: unknown): value is { error: string } {
        if (typeof value !== "object" || value === null) return false;
        const candidate = Object.fromEntries(Object.entries(value));
        return typeof candidate.error === "string";
    }

    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get("repo");
    const agentIdParam = params.get("agent_id");
    const scopesParam = params.get("scopes");
    const consentRequest: ConsentRequest | null =
        repoParam && agentIdParam && scopesParam
            ? {
                  repo: repoParam,
                  agent_id: agentIdParam,
                  scopes: scopesParam
                      .split(",")
                      .map((scope) => scope.trim())
                      .filter(Boolean),
                  repo_mode:
                      params.get("repo_mode") === "create-if-missing"
                          ? "create-if-missing"
                          : "existing-only",
              }
            : null;

    let selectedScopes = new SvelteSet<string>();
    let error = $state<string | null>(null);

    type PageState =
        | { kind: "loading" }
        | { kind: "error"; message: string }
        | {
              kind: "ready";
              user: { login: string; avatarUrl: string };
              request: ConsentRequest;
          };

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
            const userData: unknown = await res.json();
            if (!res.ok || !consentRequest || !isUser(userData)) {
                page = {
                    kind: "error",
                    message: "Invalid consent request",
                };
                return;
            }
            selectedScopes.clear();
            expandCompoundScopes(consentRequest.scopes)
                .filter((scope) => approvableScopeIds.has(scope))
                .forEach((scope) => selectedScopes.add(scope));
            page = {
                kind: "ready",
                user: userData,
                request: consentRequest,
            };
        } catch (e) {
            page = {
                kind: "error",
                message:
                    e instanceof Error
                        ? e.message
                        : "Authentication check failed",
            };
        }
    })();

    function toggleScope(scope: string) {
        if (selectedScopes.has(scope)) {
            selectedScopes.delete(scope);
        } else {
            selectedScopes.add(scope);
        }
    }

    async function handleGrant() {
        error = null;
        if (page.kind !== "ready") return;
        const scopeList = Array.from(selectedScopes);

        try {
            const res = await fetch("/api/consent", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    repo: page.request.repo,
                    agent_id: page.request.agent_id,
                    repo_mode: page.request.repo_mode,
                    scopes: scopeList.join(","),
                }),
            });
            const data: unknown = await res.json();
            if (res.ok) {
                window.location.href = "/";
            } else if (isConsentError(data)) {
                error = data.error;
            } else {
                error = "Failed to submit consent";
            }
        } catch (e) {
            error =
                e instanceof Error ? e.message : "Failed to submit consent";
        }
    }

    function handleDeny() {
        window.location.href = "/";
    }
</script>

{#if page.kind === "loading"}
    <div
        class="min-h-screen flex items-center justify-center bg-base-200"
        role="status"
    >
        <span class="text-base-content/60">Checking authentication...</span>
    </div>
{:else if page.kind === "error"}
    <div class="min-h-screen flex items-center justify-center bg-base-200">
        <div class="text-error" role="alert">
            Authentication failed: {page.message}
        </div>
    </div>
{:else if page.kind === "ready"}
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
            <div class="card bg-base-100 card-border shadow-sm">
                <div class="card-body">
                    <h2 class="card-title text-2xl">
                        Authorization Required
                    </h2>
                    <p class="text-base-content/70 mb-6">
                        Agent
                        <strong class="text-base-content"
                            >{page.request.agent_id}</strong
                        >
                        wants to access repository
                        <strong class="text-base-content"
                            >{page.request.repo}</strong
                        >
                        with the following permissions:
                    </p>
                    {#if page.request.scopes.length > 0}
                        <div
                            class="mb-6"
                            role="group"
                            aria-label="Select permissions to grant"
                        >
                            <p
                                class="text-sm font-semibold text-base-content/80 mb-3"
                            >
                                Select permissions to grant:
                            </p>
                            {#each scopeCategories as category (category.label)}
                                <fieldset class="mb-4">
                                    <legend
                                        class="text-xs font-medium text-base-content/60 uppercase tracking-wider mb-2"
                                        >{category.label}</legend
                                    >
                                    <div class="space-y-2">
                                        {#each category.scopes as scope (scope.id)}
                                            <label
                                                class="flex items-start gap-3 cursor-pointer"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedScopes.has(
                                                        scope.id
                                                    )}
                                                    onchange={() =>
                                                        toggleScope(scope.id)}
                                                    class="checkbox checkbox-sm mt-1"
                                                />
                                                <div>
                                                    <span
                                                        class="text-sm font-medium text-base-content"
                                                        >{scope.id}</span
                                                    >
                                                    <p
                                                        class="text-xs text-base-content/60"
                                                    >
                                                        {scope.description}
                                                    </p>
                                                </div>
                                            </label>
                                        {/each}
                                    </div>
                                </fieldset>
                            {/each}
                        </div>
                    {/if}

                    {#if error}
                        <div class="alert alert-error mb-4 text-sm" role="alert">
                            {error}
                        </div>
                    {/if}
                    <div class="card-actions flex gap-3">
                        {#if page.request.repo_mode === "create-if-missing"}
                            <button
                                onclick={handleGrant}
                                class="btn btn-outline flex-1"
                                title="Create {page.request.repo} as a private repository only if it is missing."
                            >
                                Create private repo &amp; allow
                            </button>
                        {:else}
                            <button
                                onclick={handleGrant}
                                class="btn btn-neutral flex-1"
                            >
                                Grant Access
                            </button>
                        {/if}
                        <button onclick={handleDeny} class="btn btn-ghost flex-1">
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
{:else}
    <!--Should not happen, this is just exist for help eslint check types-->
{/if}
