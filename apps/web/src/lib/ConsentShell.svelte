<script lang="ts">
    import type { Snippet } from "svelte";
    import type { SignedInUser } from "@/lib/session";

    /** Loading and error screens, then the nav bar and a card around `children`. */
    let {
        status,
        children,
    }: {
        status:
            | { kind: "loading" }
            | { kind: "error"; message: string }
            | { kind: "ready"; user: SignedInUser };
        children: Snippet;
    } = $props();

    // Narrowed in script: the template linter cannot resolve a prop union.
    const user = $derived(status.kind === "ready" ? status.user : null);
</script>

{#if status.kind === "loading"}
    <div
        class="min-h-screen flex items-center justify-center bg-base-200"
        role="status"
    >
        <span class="text-base-content/60">Checking authentication...</span>
    </div>
{:else if status.kind === "error"}
    <div class="min-h-screen flex items-center justify-center bg-base-200">
        <div class="text-error" role="alert">
            Authentication failed: {status.message}
        </div>
    </div>
{:else if user}
    <div class="min-h-screen bg-base-200">
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
                    {@render children()}
                </div>
            </div>
        </div>
    </div>
{/if}
