<script lang="ts">
    let { initialCount = 0 }: { initialCount: number } = $props();
    let count = $state(initialCount);
</script>

<div>
    <p>Count is {count}</p>
    <button onclick={() => count++}>Increment</button>
    <button onclick={() => count = initialCount}>Reset</button>
</div>
