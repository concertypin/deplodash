<script lang="ts">
    let { initialCount = 0 }: { initialCount: number } = $props();
    // svelte-ignore state_referenced_locally
    let count = $state(initialCount);
    function reset() { count = initialCount; }
</script>

<div>
    <p>Count is {count}</p>
    <button onclick={() => count++}>Increment</button>
    <button onclick={reset}>Reset</button>
</div>
