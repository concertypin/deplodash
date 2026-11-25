<script lang="ts">
    import { approvableScopeIds, scopeCategories, expandCompoundScopes } from "@/lib/scopes";
    import { SvelteSet } from "svelte/reactivity";
    import ConsentShell from "@/lib/ConsentShell.svelte";
    import {
        apiErrorMessage,
        loadSignedInUser,
        type SignedInUser,
    } from "@/lib/session";

    type RepositoryMode = "existing-only" | "create-if-missing";
    type ConsentRequest = {
        repo: string;
        agent_id: string;
        scopes: string[];
        repo_mode: RepositoryMode;
    };

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

    // Immutable snapshot of the granular scope IDs the agent initially
    // requested. Requested scopes render first (checked by default); every
    // other approvable scope is folded into the additional-permissions
    // disclosure. `selectedScopes` is a mutable copy users can extend.
    const requestedScopeIds = new Set(
        consentRequest
            ? expandCompoundScopes(consentRequest.scopes).filter((scope) =>
                  approvableScopeIds.has(scope)
              )
            : []
    );

    // Categories containing at least one requested scope, restricted to the
    // requested scopes so unrequested choices stay inside the disclosure.
    const requestedCategories = scopeCategories
        .map((category) => ({
            label: category.label,
            scopes: category.scopes.filter((scope) =>
                requestedScopeIds.has(scope.id)
            ),
        }))
        .filter((category) => category.scopes.length > 0);

    // Categories with any scope the agent did not request, shown only inside
    // the additional-permissions disclosure.
    const additionalCategories = scopeCategories
        .map((category) => ({
            label: category.label,
            scopes: category.scopes.filter(
                (scope) => !requestedScopeIds.has(scope.id)
            ),
        }))
        .filter((category) => category.scopes.length > 0);

    const additionalScopeCount = additionalCategories.reduce(
        (total, category) => total + category.scopes.length,
        0
    );

    let selectedScopes = new SvelteSet<string>([...requestedScopeIds]);
    let error = $state<string | null>(null);

    type PageState =
        | { kind: "loading" }
        | { kind: "error"; message: string }
        | {
              kind: "ready";
              user: SignedInUser;
              request: ConsentRequest;
          };

    let page = $state<PageState>({ kind: "loading" });

    (async () => {
        try {
            const user = await loadSignedInUser();
            if (user === "redirected") return;
            if (!user || !consentRequest) {
                page = {
                    kind: "error",
                    message: "Invalid consent request",
                };
                return;
            }
            page = {
                kind: "ready",
                user,
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
            } else {
                error = apiErrorMessage(data) ?? "Failed to submit consent";
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

<ConsentShell status={page}>
    {#if page.kind === "ready"}
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
                {#each requestedCategories as category (category.label)}
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
                {#if additionalScopeCount > 0}
                    <details class="collapse collapse-arrow">
                        <summary class="collapse-title">
                            Additional permissions
                            ({additionalScopeCount})
                        </summary>
                        <div class="collapse-content">
                            {#each additionalCategories as category (category.label)}
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
                                                        toggleScope(
                                                            scope.id
                                                        )}
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
                    </details>
                {/if}
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
    {/if}
</ConsentShell>
