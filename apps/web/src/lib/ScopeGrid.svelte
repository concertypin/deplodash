<script lang="ts">
    import { scopeCategories } from "@/lib/scopes";
</script>

<div>
    {#each scopeCategories as cat}
        <section>
            <h3>{cat.label}</h3>
            <ul>
                {#each cat.scopes as scope}
                    <li>
                        <span class="scope-id">{scope.id}</span>
                        <span class="scope-desc">{scope.description}</span>
                    </li>
                {/each}
            </ul>
        </section>
    {/each}
</div>
