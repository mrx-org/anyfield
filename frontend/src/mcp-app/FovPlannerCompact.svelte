<script lang="ts">
  import FovPlanner from "../lib/components/fov/FovPlanner.svelte";
  import type { SessionStore } from "../lib/state/session.svelte";

  let { store }: { store: SessionStore } = $props();
</script>

<FovPlanner {store} compact />
