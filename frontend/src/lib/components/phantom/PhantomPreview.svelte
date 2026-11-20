<script lang="ts">
  // The phantom preview: a large, square view of the chosen phantom, with the plane,
  // the property and the tissues to pick (state field `view`). Loads the phantom's
  // maps only while it is shown. Standalone (open_phantom_preview) or nested in the browser.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Check from "@lucide/svelte/icons/check";
  import { Menu, Portal } from "@skeletonlabs/skeleton-svelte";
  import { phantomKey, phantomSource } from "../../phantom";
  import { MapsLoader } from "../../state/maps.svelte";
  import { DEFAULT_PHANTOM } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { PhantomChoice, Plane } from "../../types";
  import VolumePreview from "./VolumePreview.svelte";

  let { sel }: { sel: Selection } = $props();

  const PLANES: { key: Plane; label: string }[] = [
    { key: "tra", label: "Transversal" },
    { key: "cor", label: "Koronal" },
    { key: "sag", label: "Sagittal" },
    { key: "3d", label: "3D" },
  ];
  // Several clicks on tissues in a row compute the maps once (each takes seconds)
  const LOAD_DELAY_MS = 400;

  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);
  const phantom = $derived(sel.state?.phantom ?? null);
  const name = $derived((phantom ?? DEFAULT_PHANTOM).name.replace(/\.(json|zip)$/, ""));
  const shown = $derived(maps.property(sel.state?.view.property ?? "density"));
  const plane = $derived(sel.state?.view.plane ?? "tra");
  /** Tissues chosen; null: all. */
  const chosen = $derived(sel.state?.view.tissues?.length ? sel.state.view.tissues : null);

  // The maps to load: phantom and tissues together, so a new phantom never goes out
  // with the old one's tissues. The first request goes at once, later ones settle first.
  let request = $state<{ phantom: PhantomChoice | null; tissues: string[] | null } | null>(null);
  // Not reactive: reading `request` here would re-run this effect on every request it sets
  let requested = false;
  $effect(() => {
    if (!sel.state) return;
    const next = $state.snapshot({ phantom, tissues: chosen });
    if (!requested) {
      requested = true;
      request = next;
      return;
    }
    const t = setTimeout(() => (request = next), LOAD_DELAY_MS);
    return () => clearTimeout(t);
  });
  $effect(() => {
    if (request) maps.load(request.phantom, undefined, request.tissues);
  });

  // The phantom's tissues, for the third dropdown
  let tissueList = $state<string[] | null>(null);
  let tissueError = $state<string | null>(null);
  let tissuesOf: string | null = null;
  $effect(() => {
    if (!sel.state) return;
    const p = $state.snapshot(phantom);
    const key = p ? phantomKey(p) : "";
    if (key === tissuesOf) return;
    tissuesOf = key;
    tissueList = null;
    tissueError = null;
    sel.client.listTissues(p).then(
      (list) => {
        if (tissuesOf === key) tissueList = list;
      },
      (e) => {
        if (tissuesOf === key) tissueError = e instanceof Error ? e.message : String(e);
      },
    );
  });

  const isOn = (t: string) => chosen === null || chosen.includes(t);
  const tissueLabel = $derived(
    chosen === null ? "Alle Gewebe" : chosen.length <= 2 ? chosen.join(", ") : `${chosen.length} Gewebe`,
  );

  function toggle(t: string, on: boolean) {
    const list = tissueList;
    if (!list) return;
    const next = (chosen ?? list).filter((x) => x !== t && list.includes(x));
    if (on) next.push(t);
    if (next.length === 0) return; // at least one
    sel.patch({ view: { tissues: next.length === list.length ? null : next.sort() } });
  }

  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
</script>

<div class="flex flex-col gap-2 p-2 text-sm text-text">
  <div class="flex items-baseline gap-2">
    <span class="truncate font-medium" title="{(phantom ?? DEFAULT_PHANTOM).name} ({phantomSource(phantom ?? DEFAULT_PHANTOM)})">
      {name}{#if !phantom}<span class="ml-1 text-xs font-normal text-muted">(Standard)</span>{/if}
    </span>
    {#if maps.loading}<span class="shrink-0 text-xs text-accent">wird vorbereitet …</span>{/if}
  </div>

  <VolumePreview url={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} {plane} class="" />

  <div class="grid grid-cols-3 gap-2">
    <select
      class="select text-xs"
      aria-label="Ansicht"
      value={plane}
      onchange={(e) => sel.patch({ view: { plane: e.currentTarget.value as Plane } })}
    >
      {#each PLANES as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
    </select>
    <select
      class="select text-xs"
      aria-label="Eigenschaft"
      value={shown?.key ?? ""}
      disabled={!maps.maps}
      onchange={(e) => sel.patch({ view: { property: e.currentTarget.value } })}
    >
      {#each maps.maps?.properties ?? [] as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
    </select>
    <!-- Tissues: several at once, so a menu of checkbox items that stays open. Skeleton's
         standard anatomy; the Portal puts it on <body>, out of the column that would clip it. -->
    <Menu closeOnSelect={false}>
      <Menu.Trigger
        class="input flex min-w-0 items-center gap-1 px-2 py-1 text-left text-xs"
        disabled={!tissueList}
        aria-label="Gewebe"
        title={chosen?.join(", ") ?? "Alle Gewebe"}
      >
        <span class="min-w-0 flex-1 truncate">{tissueList ? tissueLabel : "Gewebe …"}</span>
        <ChevronDown class="size-4 shrink-0 text-muted" aria-hidden="true" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.OptionItem
              type="checkbox"
              value="*"
              checked={chosen === null}
              onCheckedChange={() => sel.patch({ view: { tissues: null } })}
            >
              <Menu.ItemText>Alle</Menu.ItemText>
              <Menu.ItemIndicator><Check class="size-4" /></Menu.ItemIndicator>
            </Menu.OptionItem>
            <Menu.Separator />
            {#each tissueList ?? [] as t (t)}
              <Menu.OptionItem
                type="checkbox"
                value={t}
                checked={isOn(t)}
                disabled={chosen?.length === 1 && chosen[0] === t}
                onCheckedChange={(on) => toggle(t, on)}
              >
                <Menu.ItemText>{t}</Menu.ItemText>
                <Menu.ItemIndicator><Check class="size-4" /></Menu.ItemIndicator>
              </Menu.OptionItem>
            {/each}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu>
  </div>

  {#if shown?.range}
    <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
  {/if}
  {#if maps.error}<p class="text-xs text-error-500">{maps.error}</p>{/if}
  {#if tissueError}<p class="text-xs text-error-500">Gewebe: {tissueError}</p>{/if}
  {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
</div>
