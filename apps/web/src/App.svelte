<script lang="ts">
    import Router from "svelte-spa-router";
    import HomePage from "@/lib/HomePage.svelte";
    import ConsentPage from "@/lib/ConsentPage.svelte";

    const routes = {
        "/": HomePage,
        "/auth/consent": ConsentPage,
        "*": HomePage,
    };
</script>

<Router {routes} />
