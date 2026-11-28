<script lang="ts">
  // The workspace: several tools in panels (dockview), arranged as the state's
  // `layout` says (null: DEFAULT_LAYOUT). Dragging tabs, splitting, resizing and
  // closing change the layout, sent once the user has let go; a layout changed
  // elsewhere (by the AI, on another device) is shown here. All panels hang on the
  // same Selection. Narrow (phone), the panels are tabs one after the other; the
  // layout stays as it is.
  import { m } from "../../../paraglide/messages.js";
  import { Tabs } from "@skeletonlabs/skeleton-svelte";
  import { createDockview, type DockviewApi, type GroupPanelPartInitParameters, type IContentRenderer } from "dockview";
  import "dockview/dist/styles/dockview.css";
  import { mount, onDestroy, onMount, unmount } from "svelte";
  import Maximize2 from "@lucide/svelte/icons/maximize-2";
  import Minimize2 from "@lucide/svelte/icons/minimize-2";
  import Languages from "@lucide/svelte/icons/languages";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import MessageSquareOff from "@lucide/svelte/icons/message-square-off";
  import Moon from "@lucide/svelte/icons/moon";
  import Palette from "@lucide/svelte/icons/palette";
  import Sun from "@lucide/svelte/icons/sun";
  import SunMoon from "@lucide/svelte/icons/sun-moon";
  import { i18n, LOCALE_NAMES, LOCALES, type Locale } from "../../i18n.svelte";
  import { changePrefs, chatTheme, DEFAULT_THEME, mode, prefs, THEMES, type Mode, type ThemeName } from "../../settings.svelte";
  import {
    DEFAULT_LAYOUT,
    fromDockview,
    layoutPatch,
    newPanelId,
    normalize,
    panelsOf,
    sameLayout,
    toDockview,
    withPanel,
  } from "../../layout";
  import type { Selection } from "../../state/selection";
  import { TOOLS } from "../../tools";
  import type { Layout } from "../../types";

  let { sel }: { sel: Selection } = $props();

  const layout = $derived<Layout | null>(sel.state ? (sel.state.layout ?? DEFAULT_LAYOUT) : null);
  const isDefault = $derived(!sel.state?.layout);
  const addable = $derived(Object.entries(TOOLS).filter(([, t]) => !t.needsSession || sel.sessionKey));

  let host = $state<HTMLDivElement>();
  let api = $state.raw<DockviewApi | null>(null);
  /** Wide enough for panels side by side; else tabs. */
  let wide = $state(true);
  /** What dockview shows, in our form. */
  let shown: Layout | null = null;
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // svelte-ignore state_referenced_locally
  let fullscreen = $state(sel.client.transport.fullscreen?.() ?? { available: false, active: false });

  /** A panel's content: the tool's component on the workspace's Selection, with its options. */
  class ToolPanel implements IContentRenderer {
    readonly element = document.createElement("div");
    private instance: Record<string, unknown> | null = null;
    private tool: string;
    constructor(tool: string) {
      this.tool = tool;
      this.element.className = "h-full w-full overflow-auto bg-bg text-text";
    }
    init(params: GroupPanelPartInitParameters) {
      const def = TOOLS[this.tool];
      if (!def || (def.needsSession && !sel.sessionKey)) {
        this.element.className += " p-3 text-xs text-muted";
        this.element.textContent = def ? m.workspace_needs_session({ tool: this.tool }) : m.workspace_unknown_tool({ tool: this.tool });
        return;
      }
      const options = (params.params?.options ?? {}) as Record<string, unknown>;
      this.instance = mount(def.component, { target: this.element, props: { sel, ...options } });
    }
    dispose() {
      if (this.instance) void unmount(this.instance);
      this.instance = null;
    }
  }

  onMount(() => {
    const media = matchMedia("(min-width: 768px)");
    wide = media.matches;
    const onMedia = () => (wide = media.matches);
    media.addEventListener("change", onMedia);
    const dock = createDockview(host!, {
      createComponent: (o) => new ToolPanel(o.name),
      theme: { name: "anyfield", className: "dockview-theme-dark anyfield-dock" },
      disableFloatingGroups: true,
    });
    const sub = dock.onDidLayoutChange(() => {
      if (!applying) schedule();
    });
    api = dock;
    return () => {
      media.removeEventListener("change", onMedia);
      sub.dispose();
      dock.dispose();
    };
  });

  onDestroy(() => clearTimeout(timer));

  // A layout from the state that dockview does not show yet: show it
  $effect(() => {
    const l = layout;
    if (!api || !l || !wide || !host) return;
    if (shown && sameLayout(shown, l)) return;
    applying = true;
    try {
      const n = normalize(l);
      if (n.root) api.fromJSON(toDockview(n, host.clientWidth || 800, host.clientHeight || 600, (t) => t));
      else api.clear();
      shown = n;
    } finally {
      applying = false;
    }
  });

  // Dragging a sash fires on every pixel: send when it has settled
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(commit, 300);
  }

  function commit() {
    if (!api || !layout) return;
    const now = fromDockview(api.toJSON());
    shown = now;
    if (!sameLayout(now, layout)) sel.patch({ layout: layoutPatch(now) });
  }

  function add(tool: string) {
    if (!tool || !layout) return;
    const id = newPanelId(layout);
    // In dockview: a tab of the active group, else of the first (dockview reports the
    // change); narrow: into the state
    const group = api?.activeGroup ?? api?.groups[0];
    if (wide && api)
      api.addPanel({
        id,
        component: tool,
        title: tool,
        params: { options: {} },
        ...(group ? { position: { referenceGroup: group, direction: "within" as const } } : {}),
      });
    else sel.patch({ layout: layoutPatch(withPanel(layout, { id, tool })) });
    tab = id;
  }

  async function toggleFullscreen() {
    await sel.client.transport.setFullscreen?.(!fullscreen.active);
    fullscreen = sel.client.transport.fullscreen?.() ?? fullscreen;
  }

  const modeTitle = $derived(
    { light: m.settings_mode_light(), dark: m.settings_mode_dark(), auto: m.settings_mode_auto() }[mode()],
  );
  const chatTitle = $derived(chatTheme() ? m.settings_chat_theme_on() : m.settings_chat_theme_off());

  // Narrow: one tab per panel
  const narrowPanels = $derived(panelsOf(layout));
  let tab = $state<string>("");
  const current = $derived(narrowPanels.find((p) => p.id === tab) ?? narrowPanels[0]);
</script>

<div class="flex h-full min-h-[32rem] flex-col text-sm text-text">
  <div class="flex items-center gap-2 border-b border-border px-2 py-1">
    <!-- One button per tool: adds it as a tab of the active area -->
    <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto" role="toolbar" aria-label={m.workspace_add_tool()}>
      {#each addable as [name, t] (name)}
        <button
          type="button"
          class="btn-icon btn-icon-sm hover:preset-tonal shrink-0"
          aria-label={m.workspace_add({ label: t.label() })}
          title="{m.workspace_add({ label: t.label() })} ({name})"
          onclick={() => add(name)}
        >
          <t.icon class="size-4" aria-hidden="true" />
        </button>
      {/each}
    </div>
    {#if !isDefault}
      <button
        type="button"
        class="btn btn-sm hover:preset-tonal text-xs"
        title={m.workspace_default_layout()}
        onclick={() => sel.patch({ layout: null })}
      >
        <RotateCcw class="size-4" aria-hidden="true" /> {m.common_default()}
      </button>
    {/if}
    {#if sel.error}<span class="truncate text-xs text-error-500">{sel.error}</span>{/if}
    <!-- The user's settings (stored with a login, on the website also in the browser) -->
    <div class="ml-auto flex shrink-0 items-center gap-1 text-muted">
      <label class="flex items-center gap-1" title={m.common_language()}>
        <Languages class="size-4" aria-hidden="true" />
        <select
          class="select w-auto py-0.5 text-xs"
          aria-label={m.common_language()}
          value={i18n.locale}
          onchange={(e) => changePrefs({ locale: e.currentTarget.value as Locale })}
        >
          {#each LOCALES as l (l)}<option value={l}>{LOCALE_NAMES[l]}</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-1" title={m.settings_theme()}>
        <Palette class="size-4" aria-hidden="true" />
        <select
          class="select w-auto py-0.5 text-xs"
          aria-label={m.settings_theme()}
          value={prefs.settings.theme ?? DEFAULT_THEME}
          onchange={(e) => changePrefs({ theme: e.currentTarget.value as ThemeName })}
        >
          {#each THEMES as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      </label>
      <button
        type="button"
        class="btn-icon btn-icon-sm hover:preset-tonal"
        aria-label={modeTitle}
        title={modeTitle}
        onclick={() => changePrefs({ mode: ({ auto: "light", light: "dark", dark: "auto" } as Record<Mode, Mode>)[mode()] })}
      >
        {#if mode() === "light"}<Sun class="size-4" aria-hidden="true" />{:else if mode() === "dark"}<Moon class="size-4" aria-hidden="true" />{:else}<SunMoon class="size-4" aria-hidden="true" />{/if}
      </button>
      <button
        type="button"
        class="btn-icon btn-icon-sm hover:preset-tonal"
        aria-label={chatTitle}
        aria-pressed={chatTheme()}
        title={chatTitle}
        onclick={() => changePrefs({ chat_theme: !chatTheme() })}
      >
        {#if chatTheme()}<MessageSquare class="size-4" aria-hidden="true" />{:else}<MessageSquareOff class="size-4" aria-hidden="true" />{/if}
      </button>
    </div>
    {#if fullscreen.available}
      <button
        type="button"
        class="btn-icon btn-icon-sm hover:preset-tonal shrink-0"
        aria-label={fullscreen.active ? m.workspace_exit_fullscreen() : m.workspace_fullscreen()}
        title={fullscreen.active ? m.workspace_exit_fullscreen() : m.workspace_fullscreen()}
        onclick={toggleFullscreen}
      >
        {#if fullscreen.active}<Minimize2 class="size-4" aria-hidden="true" />{:else}<Maximize2 class="size-4" aria-hidden="true" />{/if}
      </button>
    {/if}
  </div>

  <!-- dockview stays mounted while narrow (hidden), so its panels need not be rebuilt -->
  <div class="relative min-h-0 flex-1 {wide ? '' : 'hidden'}">
    <div bind:this={host} class="absolute inset-0"></div>
    {#if wide && layout && !layout.root}
      <p class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted">
        {m.workspace_empty()}
      </p>
    {/if}
  </div>

  {#if !wide}
    {#if narrowPanels.length}
      <Tabs value={current?.id ?? ""} onValueChange={(d) => (tab = d.value)}>
        <Tabs.List class="overflow-x-auto px-2 whitespace-nowrap">
          {#each narrowPanels as p (p.id)}<Tabs.Trigger value={p.id} class="font-mono text-xs">{p.tool}</Tabs.Trigger>{/each}
          <Tabs.Indicator />
        </Tabs.List>
      </Tabs>
      {#if current}
        {@const def = TOOLS[current.tool]}
        {#key current.id}
          <div class="min-h-0 flex-1 overflow-auto">
            {#if def && (!def.needsSession || sel.sessionKey)}
              <def.component {sel} {...current.options ?? {}} />
            {:else}
              <p class="p-3 text-xs text-muted">{def ? m.workspace_needs_session({ tool: current.tool }) : m.workspace_unknown_tool({ tool: current.tool })}</p>
            {/if}
          </div>
        {/key}
      {/if}
    {:else}
      <p class="p-3 text-xs text-muted">{m.workspace_empty()}</p>
    {/if}
  {/if}
</div>

<style>
  /* dockview in anyfield's colours (light and dark follow our tokens); tab titles are
     tool names, in the mono font of the tool frames */
  :global(.anyfield-dock) {
    color-scheme: inherit;
    --dv-group-view-background-color: var(--color-bg);
    --dv-tabs-and-actions-container-background-color: var(--color-panel);
    --dv-activegroup-visiblepanel-tab-background-color: var(--color-bg);
    --dv-activegroup-hiddenpanel-tab-background-color: var(--color-panel);
    --dv-inactivegroup-visiblepanel-tab-background-color: var(--color-bg);
    --dv-inactivegroup-hiddenpanel-tab-background-color: var(--color-panel);
    --dv-tab-divider-color: var(--color-border);
    --dv-activegroup-visiblepanel-tab-color: var(--color-text);
    --dv-activegroup-hiddenpanel-tab-color: var(--color-muted);
    --dv-inactivegroup-visiblepanel-tab-color: var(--color-text);
    --dv-inactivegroup-hiddenpanel-tab-color: var(--color-muted);
    --dv-separator-border: var(--color-border);
    --dv-paneview-header-border-color: var(--color-border);
    --dv-sash-color: var(--color-border);
    --dv-active-sash-color: var(--color-accent);
    --dv-drag-over-background-color: color-mix(in oklab, var(--color-accent) 25%, transparent);
    --dv-icon-hover-background-color: color-mix(in oklab, var(--color-muted) 25%, transparent);
    --dv-tabs-and-actions-container-font-size: 11px;
    --dv-tabs-and-actions-container-height: 28px;
  }
  :global(.anyfield-dock .dv-tab) {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
</style>
