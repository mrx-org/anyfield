<script lang="ts">
  // Which tissues of the chosen phantom are viewed (and later simulated): state field
  // `tissues`, next to `phantom`; null means all. Several at once, so a menu of checkbox
  // items that stays open. Skeleton's standard anatomy; the Portal puts it on <body>,
  // out of a column that would clip it.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Check from "@lucide/svelte/icons/check";
  import { Menu, Portal } from "@skeletonlabs/skeleton-svelte";
  import { phantomKey } from "../../phantom";
  import type { Selection } from "../../state/selection";

  let { sel }: { sel: Selection } = $props();

  const phantom = $derived(sel.state?.phantom ?? null);
  /** Tissues chosen; null: all. */
  const chosen = $derived(sel.state?.tissues?.length ? sel.state.tissues : null);

  // The phantom's tissues (a short list from the gateway, no maps)
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
  const label = $derived(
    chosen === null ? "Alle Gewebe" : chosen.length <= 2 ? chosen.join(", ") : `${chosen.length} Gewebe`,
  );

  function toggle(t: string, on: boolean) {
    const list = tissueList;
    if (!list) return;
    const next = (chosen ?? list).filter((x) => x !== t && list.includes(x));
    if (on) next.push(t);
    if (next.length === 0) return; // at least one
    sel.patch({ tissues: next.length === list.length ? null : next.sort() });
  }
</script>

<Menu closeOnSelect={false}>
  <Menu.Trigger
    class="input flex min-w-0 items-center gap-1 px-2 py-1 text-left text-xs"
    disabled={!tissueList}
    aria-label="Gewebe"
    title={chosen?.join(", ") ?? "Alle Gewebe"}
  >
    <span class="min-w-0 flex-1 truncate">{tissueList ? label : "Gewebe …"}</span>
    <ChevronDown class="size-4 shrink-0 text-muted" aria-hidden="true" />
  </Menu.Trigger>
  <Portal>
    <Menu.Positioner>
      <Menu.Content>
        <Menu.OptionItem type="checkbox" value="*" checked={chosen === null} onCheckedChange={() => sel.patch({ tissues: null })}>
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
{#if tissueError}<p class="text-xs text-error-500">Gewebe: {tissueError}</p>{/if}
