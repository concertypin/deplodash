<script lang="ts">
    import { route } from "@/lib/router.svelte";
    import HomePage from "@/lib/HomePage.svelte";
    import ConsentPage from "@/lib/ConsentPage.svelte";
    import OidcConsentPage from "@/lib/OidcConsentPage.svelte";
</script>

{#if route.current === "/auth/consent"}
    <ConsentPage />
{:else if route.current === "/auth/oidc-consent"}
    <OidcConsentPage />
{:else}
    <HomePage />
{/if}
