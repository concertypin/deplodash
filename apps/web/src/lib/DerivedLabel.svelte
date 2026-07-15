<script lang="ts">
    let count = $state(0);
    let doubled = $derived(count * 2);
</script>

<div>
    <p>Count: {count}</p>
    <p>Double: {doubled}</p>
    <button onclick={() => count++}>+1</button>
</div>
