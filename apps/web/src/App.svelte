<script lang="ts">
    import { route } from "@/lib/router.svelte";
    import HomePage from "@/lib/HomePage.svelte";
    import ConsentPage from "@/lib/ConsentPage.svelte";
</script>

{#if route.current === "/auth/consent"}
    <ConsentPage />
{:else}
    <HomePage />
{/if}
