<script lang="ts">
    let name = $state("");
    let email = $state("");
</script>

<form>
    <label for="name">Name</label>
    <input id="name" type="text" bind:value={name} />
    <label for="email">Email</label>
    <input id="email" type="email" bind:value={email} />
    <button type="submit">Submit</button>
</form>
