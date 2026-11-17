<script lang="ts">
  import FovPlanner from "../lib/components/fov/FovPlanner.svelte";
  import type { Selection } from "../lib/state/selection";

  let { sel }: { sel: Selection } = $props();
</script>

<FovPlanner {sel} compact />
