<script lang="ts">
  // A JSON text editor (CodeMirror 6): syntax highlighting, brackets, undo, and syntax
  // errors marked in the text. `value` sets the text from outside (e.g. after a
  // reload); what the user types goes out through `onchange`.
  import { json, jsonParseLinter } from "@codemirror/lang-json";
  import { linter, lintGutter } from "@codemirror/lint";
  import { Compartment, EditorState, Prec } from "@codemirror/state";
  import { oneDark } from "@codemirror/theme-one-dark";
  import { EditorView } from "@codemirror/view";
  import { basicSetup } from "codemirror";
  import { onMount } from "svelte";
  import { theme } from "../../theme.svelte";

  let {
    value,
    onchange,
    class: cls = "",
  }: {
    value: string;
    onchange: (text: string) => void;
    class?: string;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  /** The dark theme, swapped when the page turns light or dark. */
  const scheme = new Compartment();

  // The page's look, over the dark theme's: transparent, small text, as tall as the box
  const look = Prec.highest(
    EditorView.theme({
      "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent" },
      ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--color-border)" },
      ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, ui-monospace, monospace)" },
    }),
  );

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          json(),
          linter(jsonParseLinter(), { delay: 300 }),
          lintGutter(),
          scheme.of(theme.dark ? oneDark : []),
          look,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => {
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    const dark = theme.dark;
    view?.dispatch({ effects: scheme.reconfigure(dark ? oneDark : []) });
  });

  // A new value from outside replaces the text (not what the user just typed)
  $effect(() => {
    const v = value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });
</script>

<div bind:this={host} class="min-h-0 overflow-hidden rounded border border-border {cls}"></div>
