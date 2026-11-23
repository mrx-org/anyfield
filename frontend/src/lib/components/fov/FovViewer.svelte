<script lang="ts">
  // The visual FOV planner: the phantom with the FOV box on top. Wide, it shows the
  // 2×2 grid (three planes and 3D); narrow, one plane with a switch above it. The plane
  // is per view (device), not in the state. Property and tissues follow the state's
  // `view`, as in the phantom preview. The sliders are the FOV planner (FovPlanner).
  // Bound to a Selection, so it works on a session, locally in an MCP App, and on the website.
  import { SegmentedControl } from "@skeletonlabs/skeleton-svelte";
  import { MapsLoader } from "../../state/maps.svelte";
  import type { Selection } from "../../state/selection";
  import type { Plane } from "../../types";
  import PhantomViewer from "../phantom/PhantomViewer.svelte";

  let { sel }: { sel: Selection } = $props();

  const PLANES: { key: Plane; label: string }[] = [
    { key: "tra", label: "Tra" },
    { key: "cor", label: "Kor" },
    { key: "sag", label: "Sag" },
    { key: "3d", label: "3D" },
  ];

  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);
  const shown = $derived(maps.property(sel.state?.view.property ?? "density"));
  let plane = $state<Plane>("tra");
  let single = $state(true);

  $effect(() => {
    if (sel.state) maps.load(sel.state.phantom, undefined, sel.state.view.tissues ?? null);
  });
</script>

<div class="flex h-full min-h-64 flex-col gap-1 text-sm text-text">
  {#if single}
    <SegmentedControl value={plane} onValueChange={(d) => d.value && (plane = d.value as Plane)}>
      <SegmentedControl.Control class="w-full">
        <SegmentedControl.Indicator />
        {#each PLANES as p (p.key)}
          <SegmentedControl.Item value={p.key} class="flex-1 text-xs">
            <SegmentedControl.ItemText>{p.label}</SegmentedControl.ItemText>
            <SegmentedControl.ItemHiddenInput />
          </SegmentedControl.Item>
        {/each}
      </SegmentedControl.Control>
    </SegmentedControl>
  {/if}
  {#if sel.state}
    <PhantomViewer
      url={maps.loading ? null : (shown?.url ?? null)}
      range={shown?.range ?? null}
      fov={sel.state.fov}
      layout="auto"
      {plane}
      bind:single
      class="min-h-0 w-full flex-1"
    />
  {:else if sel.error}
    <p class="p-4 text-error-500">{sel.error}</p>
  {:else}
    <p class="p-4 text-muted">Lade Session …</p>
  {/if}
  {#if maps.loading}<p class="text-xs text-accent">Phantom wird vorbereitet …</p>{/if}
  {#if sel.state && (sel.error || maps.error)}
    <p class="text-xs text-error-500">{sel.error ?? maps.error}</p>
  {/if}
</div>
