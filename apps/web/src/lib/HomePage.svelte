<script lang="ts">
    import { SvelteMap, SvelteSet } from "svelte/reactivity";
    import { GithubLogoIcon } from "phosphor-svelte";
    import { client } from "@/lib/api";
    interface ConsentItem {
        repo: string;
        scopes: string;
        granted_at: string;
        granted_by?: string | undefined;
        agent_id?: string | undefined;
    }
    interface ConsentGroup {
        repo: string;
        agent_id?: string | undefined;
        scopes: string[];
        granted_at: string;
        items: ConsentItem[];
    }

    function consentMemberKey(item: ConsentItem): string {
        const scopes = item.scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean)
            .sort()
            .join(",");
        return `${item.repo.trim().toLowerCase()}|${item.agent_id ?? ""}|${scopes}`;
    }

    function groupConsents(items: ConsentItem[]): ConsentGroup[] {
        const groups = new SvelteMap<string, ConsentGroup>();
        for (const item of items) {
            const key = `${item.repo.trim().toLowerCase()}|${item.agent_id ?? ""}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    repo: item.repo,
                    agent_id: item.agent_id,
                    scopes: [],
                    granted_at: item.granted_at,
                    items: [],
                };
                groups.set(key, group);
            }

            const memberKey = consentMemberKey(item);
            if (
                group.items.some(
                    (existing) => consentMemberKey(existing) === memberKey
                )
            ) {
                if (item.granted_at > group.granted_at) {
                    group.granted_at = item.granted_at;
                }
                continue;
            }

            if (item.granted_at > group.granted_at) {
                group.granted_at = item.granted_at;
            }
            for (const scope of item.scopes
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)) {
                if (!group.scopes.includes(scope)) {
                    group.scopes.push(scope);
                }
            }
            group.items.push(item);
        }
        return [...groups.values()].sort(
            (a, b) =>
                a.granted_at < b.granted_at
                    ? 1
                    : a.granted_at > b.granted_at
                      ? -1
                      : 0
        );
    }

function delay(milliseconds: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
}

    interface AgentToken {
        token: string;
        agent_id: string;
        label: string;
        created_at: string;
    }

    interface UserProfile {
        login: string;
        avatarUrl: string;
        name: string | null;
    }

    interface DashboardData {
        user: UserProfile;
        agentTokens: AgentToken[];
    }
    async function load(): Promise<
        { kind: "login" } | { kind: "dashboard"; data: DashboardData }
    > {
        const meRes = await client.api.user.me.$get();
        if (meRes.status === 401) return { kind: "login" };

        const user: UserProfile = await meRes.json();
        const consentsRes = await client.api.user.consents.$get();
        consentItems = consentsRes.ok
            ? (await consentsRes.json()).consents
            : [];

        const agentTokensRes = await client.api.user.agent.list.$get();
        const agentTokens: AgentToken[] = agentTokensRes.ok
            ? (await agentTokensRes.json()).tokens
            : [];

        return { kind: "dashboard", data: { user, agentTokens } };
    }
    let consentItems = $state<ConsentItem[]>([]);
    const consentGroups = $derived(groupConsents(consentItems));
    let error = $state<string | null>(null);

    const route = `POST /api/token\n{ "owner": "my-org", "repo": "my-repo", "agent_id": "my-agent" }\nAuthorization: Bearer <agent-token>`;

    let revokingGroupKey = $state<string | null>(null);

    function consentGroupKey(group: ConsentGroup): string {
        return `${group.repo.trim().toLowerCase()}|${group.agent_id ?? ""}`;
    }

    async function revokeConsentGroup(group: ConsentGroup) {
        const groupKey = consentGroupKey(group);
        if (revokingGroupKey !== null) return;
        revokingGroupKey = groupKey;
        try {
            // The revoke endpoint shares the 10-per-10-second per-IP limiter
            // with consent and auth handlers, so pace every request instead
            // of assuming an empty bucket.
            const results = await Promise.allSettled(
                group.items.map(async (item, index) => {
                    if (index > 0) await delay(index * 1200);
                    return client.api.consent.revoke.$post({
                        json: {
                            repo: item.repo,
                            scopes: item.scopes,
                            agent_id: item.agent_id,
                        },
                    });
                })
            );
            if (
                results.every(
                    (result) =>
                        result.status === "fulfilled" && result.value.ok
                )
            ) {
                window.location.reload();
                return;
            }
            const succeededKeys = new SvelteSet<string>();
            let ownershipError = false;
            results.forEach((result, index) => {
                const item = group.items[index];
                if (!item) return;
                if (result.status === "fulfilled" && result.value.ok) {
                    succeededKeys.add(consentMemberKey(item));
                } else if (
                    result.status === "fulfilled" &&
                    result.value.status === 403
                ) {
                    ownershipError = true;
                }
            });
            consentItems = consentItems.filter(
                (item) => !succeededKeys.has(consentMemberKey(item))
            );
            error = ownershipError
                ? "You cannot revoke this consent"
                : "Failed to revoke consent";
        } finally {
            revokingGroupKey = null;
        }
    }

    // ─── Agent token management state ─────────────────────────────────────────
    let modalElement = $state<HTMLDialogElement | null>(null);
    let agentIdInput = $state("");
    let labelInput = $state("");
    let isSubmitting = $state(false);

    let preauthorizeModal = $state<HTMLDialogElement | null>(null);
    let preauthorizeRepo = $state("");
    let preauthorizeAgent = $state("");
    let preauthorizeScopes = $state("contents:read");

    function openPreauthorize(tokens: AgentToken[]) {
        error = null;
        preauthorizeRepo = "";
        preauthorizeAgent = tokens[0]?.agent_id ?? "";
        preauthorizeScopes = "contents:read";
        preauthorizeModal?.showModal();
    }
    function openConsentPage() {
        const params = new URLSearchParams({
            repo: preauthorizeRepo.trim(),
            agent_id: preauthorizeAgent,
            scopes: preauthorizeScopes,
            repo_mode: "existing-only",
        });
        window.location.href = `/auth/consent?${params.toString()}`;
    }

    function openModal() {
        error = null;
        agentIdInput = "";
        labelInput = "";
        isSubmitting = false;
        modalElement?.showModal();
    }

    async function createAgentToken() {
        if (!agentIdInput.trim()) return;
        isSubmitting = true;
        try {
            const res = await client.api.user.agent.create.$post({
                json: {
                    agent_id: agentIdInput.trim(),
                    label: labelInput.trim() || undefined,
                },
            });
            if (res.ok) {
                window.location.reload();
            } else {
                error = "Failed to create agent token";
                isSubmitting = false;
            }
        } catch (e) {
            error =
                e instanceof Error ? e.message : "Failed to create agent token";
            isSubmitting = false;
        }
    }

    async function revokeAgentToken(token: string) {
        try {
            const res = await client.api.user.agent.revoke.$post({
                json: { token },
            });
            if (res.ok) {
                window.location.reload();
            } else if (res.status === 403) {
                error = "You cannot revoke this token";
            }
        } catch (e) {
            error = e instanceof Error ? e.message : "Failed to revoke token";
        }
    }

    async function copyToClipboard(text: string) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Fallback for non-secure contexts
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
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
    {:else if result.kind === "dashboard"}
        {@const { user, agentTokens } = result.data}
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
                    <pre
                        class="bg-neutral text-neutral-content rounded-box p-4 overflow-x-auto text-sm"><code
                            >{route}</code
                        ></pre>
                </div>
                {#if error}
                    <div
                        class="bg-error/10 border border-error/20 text-error rounded-box p-4 mb-6"
                        role="alert"
                    >
                        {error}
                    </div>
                {/if}

                <!-- Agent Tokens -->
                <div
                    class="bg-base-100 rounded-box shadow-sm border border-base-200 p-6 mb-8"
                >
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-semibold text-base-content">
                            Agent Tokens
                        </h3>
                        <button
                            onclick={openModal}
                            class="btn btn-primary btn-sm"
                        >
                            Issue Agent Token
                        </button>
                    </div>

                    {#if agentTokens.length === 0}
                        <div class="text-center py-8 text-base-content/60">
                            <p class="text-lg mb-2">
                                No agent tokens created yet
                            </p>
                            <p class="text-sm">
                                Create a token to authenticate your AI agents.
                            </p>
                        </div>
                    {:else}
                        <div class="overflow-x-auto">
                            <table class="table">
                                <thead>
                                    <tr>
                                        <th>Agent ID</th>
                                        <th>Label</th>
                                        <th>Token</th>
                                        <th>Created</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each agentTokens as token (token.token)}
                                        <tr>
                                            <td class="font-semibold"
                                                >{token.agent_id}</td
                                            >
                                            <td>{token.label}</td>
                                            <td class="font-mono text-xs">
                                                <div
                                                    class="flex items-center gap-2"
                                                >
                                                    <span>
                                                        {token.token.slice(
                                                            0,
                                                            8
                                                        )}...{token.token.slice(
                                                            -4
                                                        )}
                                                    </span>
                                                    <button
                                                        onclick={() =>
                                                            copyToClipboard(
                                                                token.token
                                                            )}
                                                        class="btn btn-ghost btn-xs px-1"
                                                        title="Copy full token"
                                                    >
                                                        <svg
                                                            xmlns="http://www.w3.org/2000/svg"
                                                            class="h-3.5 w-3.5"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                        >
                                                            <path
                                                                stroke-linecap="round"
                                                                stroke-linejoin="round"
                                                                stroke-width="2"
                                                                d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                                                            />
                                                        </svg>
                                                    </button>
                                                </div>
                                            </td>
                                            <td>
                                                {new Date(
                                                    token.created_at
                                                ).toLocaleDateString()}
                                            </td>
                                            <td class="text-right">
                                                <button
                                                    onclick={() =>
                                                        revokeAgentToken(
                                                            token.token
                                                        )}
                                                    class="text-error hover:text-error/80 transition-colors text-sm font-semibold"
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

                <!-- Create Agent Token Modal -->
                <dialog bind:this={modalElement} class="modal">
                    <div class="modal-box">
                        <h3 class="text-lg font-bold">Issue Agent Token</h3>
                        <div class="py-4 flex flex-col gap-3">
                            <label class="form-control w-full">
                                <span class="label-text mb-1">Agent ID</span>
                                <input
                                    type="text"
                                    placeholder="my-ai-agent"
                                    bind:value={agentIdInput}
                                    class="input input-bordered w-full"
                                />
                            </label>
                            <label class="form-control w-full">
                                <span class="label-text mb-1"
                                    >Label (optional)</span
                                >
                                <input
                                    type="text"
                                    placeholder="My AI Agent"
                                    bind:value={labelInput}
                                    class="input input-bordered w-full"
                                />
                            </label>
                        </div>
                        <div class="modal-action">
                            <button
                                onclick={() => modalElement?.close()}
                                class="btn btn-outline"
                            >
                                Cancel
                            </button>
                            <button
                                onclick={createAgentToken}
                                disabled={isSubmitting || !agentIdInput.trim()}
                                class="btn btn-primary"
                            >
                                {isSubmitting ? "Issuing..." : "Issue"}
                            </button>
                        </div>
                    </div>
                    <form method="dialog" class="modal-backdrop">
                        <button>close</button>
                    </form>
                </dialog>
                <dialog bind:this={preauthorizeModal} class="modal">
                    <div class="modal-box">
                        <h3 class="text-lg font-bold">Pre-authorize access</h3>
                        <p class="py-2 text-sm text-base-content/70">
                            Approve an agent before it requests a token.
                        </p>
                        <div class="py-4 flex flex-col gap-3">
                            <input
                                bind:value={preauthorizeRepo}
                                placeholder="owner/repository"
                                class="input input-bordered w-full"
                            />
                            <select
                                bind:value={preauthorizeAgent}
                                class="select select-bordered w-full"
                            >
                                {#each agentTokens as token (token.token)}
                                    <option value={token.agent_id}>
                                        {token.agent_id}
                                    </option>
                                {/each}
                            </select>
                            <input
                                bind:value={preauthorizeScopes}
                                placeholder="contents:read"
                                class="input input-bordered w-full"
                            />
                        </div>
                        <div class="modal-action">
                            <button
                                onclick={() => preauthorizeModal?.close()}
                                class="btn btn-outline"
                            >
                                Cancel
                            </button>
                            <button
                                onclick={openConsentPage}
                                disabled={!preauthorizeRepo.trim() || !preauthorizeAgent}
                                class="btn btn-primary"
                            >
                                Continue to consent
                            </button>
                        </div>
                    </div>
                    <form method="dialog" class="modal-backdrop">
                        <button>close</button>
                    </form>
                </dialog>
                <!-- Consents -->
                <div
                    class="bg-base-100 rounded-box shadow-sm border border-base-200 p-6"
                >
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-semibold text-base-content">
                            Authorized Repositories
                        </h3>
                        <button
                            onclick={() => openPreauthorize(agentTokens)}
                            class="btn btn-primary btn-sm"
                            disabled={agentTokens.length === 0}
                        >
                            Pre-authorize
                        </button>
                    </div>

                    {#if consentGroups.length === 0}
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
                                    {#each consentGroups as group (group.repo.trim().toLowerCase() + "|" + (group.agent_id ?? ""))}
                                        <tr>
                                            <td class="font-medium"
                                                >{group.repo}</td
                                            >
                                            <td>{group.scopes.join(", ")}</td>
                                            <td>
                                                {new Date(
                                                    group.granted_at
                                                ).toLocaleDateString()}
                                            </td>
                                            <td class="text-right">
                                                <button
                                                    onclick={() =>
                                                        revokeConsentGroup(
                                                            group
                                                        )}
                                                    aria-label={`Revoke access to ${group.repo}`}
                                                    disabled={revokingGroupKey ===
                                                        consentGroupKey(group)}
                                                    class="text-error hover:text-error/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
