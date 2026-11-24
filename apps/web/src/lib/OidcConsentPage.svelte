<script lang="ts">
    import { client } from "@/lib/api";
    import {
        parseOidcConsentParams,
        type OidcConsentRequest,
    } from "@/lib/oidc";

    /** The agent as the server knows it; never the name from the URL. */
    type OwnedAgent = { agent_id: string; label: string };

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

    const consentRequest = parseOidcConsentParams(window.location.search);

    type PageState =
        | { kind: "loading" }
        | { kind: "error"; message: string }
        | {
              kind: "ready";
              user: { login: string; avatarUrl: string };
              request: OidcConsentRequest;
              agent: OwnedAgent;
          };

    /** Server-side, owner-checked lookup by uid (403 for unknown or foreign uids). */
    async function findOwnedAgent(uid: string): Promise<OwnedAgent | null> {
        const res = await client.api.consent.oidc.agent.$get({
            query: { agent_uid: uid },
        });
        if (!res.ok) return null;
        const data: unknown = await res.json();
        return isOwnedAgent(data) ? data : null;
    }

    function isOwnedAgent(value: unknown): value is OwnedAgent {
        if (typeof value !== "object" || value === null) return false;
        const candidate = Object.fromEntries(Object.entries(value));
        return (
            typeof candidate.agent_id === "string" &&
            typeof candidate.label === "string"
        );
    }

    let page = $state<PageState>({ kind: "loading" });
    let error = $state<string | null>(null);
    let submitting = $state(false);

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
                page = { kind: "error", message: "Invalid consent request" };
                return;
            }
            const agent = await findOwnedAgent(consentRequest.agentUid);
            if (!agent) {
                page = {
                    kind: "error",
                    message: "This agent does not belong to your account",
                };
                return;
            }
            page = {
                kind: "ready",
                user: userData,
                request: consentRequest,
                agent,
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

    async function handleGrant() {
        if (page.kind !== "ready" || submitting) return;
        error = null;
        submitting = true;
        try {
            const res = await client.api.consent.oidc.$post({
                json: {
                    agent_uid: page.request.agentUid,
                    audience: page.request.audience,
                },
            });
            const data: unknown = await res.json();
            if (res.ok) {
                window.location.href = "/";
                return;
            }
            error = isConsentError(data)
                ? data.error
                : "Failed to submit consent";
        } catch (e) {
            error = e instanceof Error ? e.message : "Failed to submit consent";
        }
        submitting = false;
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
                        Google Cloud Access Required
                    </h2>
                    <p class="text-base-content/70">
                        Agent
                        <strong class="text-base-content"
                            >{page.agent.agent_id}</strong
                        >
                        wants identity tokens for this Workload Identity provider:
                    </p>
                    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm my-4">
                        <dt class="text-base-content/60">Project number</dt>
                        <dd class="font-mono">{page.request.gcp.projectNumber}</dd>
                        <dt class="text-base-content/60">Pool</dt>
                        <dd class="font-mono">{page.request.gcp.poolId}</dd>
                        <dt class="text-base-content/60">Provider</dt>
                        <dd class="font-mono">{page.request.gcp.providerId}</dd>
                        <dt class="text-base-content/60">Subject</dt>
                        <dd class="font-mono break-all">
                            agent:{page.request.agentUid}
                        </dd>
                    </dl>
                    <p class="text-sm text-base-content/70 mb-4">
                        The agent can then use whatever Google Cloud access this
                        provider grants to that subject. Approve only providers
                        you control, and restrict them with an attribute
                        condition on the subject.
                    </p>

                    {#if error}
                        <div class="alert alert-error mb-4 text-sm" role="alert">
                            {error}
                        </div>
                    {/if}
                    <div class="card-actions flex gap-3">
                        <button
                            onclick={handleGrant}
                            disabled={submitting}
                            class="btn btn-neutral flex-1"
                        >
                            Allow
                        </button>
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
