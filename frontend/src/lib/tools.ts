// The tools a workspace panel can show: name (its MCP tool without `open_`, as in
// the state's `layout`), a label for the "add tool" menu and the component. The
// backend's list is `layout.TOOLS`. The MCP Apps each import their own component
// instead: importing this would put every tool (and NiiVue) into every app.
import type { Component } from "svelte";
import FileList from "./components/files/FileList.svelte";
import FileManager from "./components/files/FileManager.svelte";
import FileUpload from "./components/files/FileUpload.svelte";
import FovPlanner from "./components/fov/FovPlanner.svelte";
import FovViewer from "./components/fov/FovViewer.svelte";
import PhantomBrowser from "./components/phantom/PhantomBrowser.svelte";
import PhantomPreview from "./components/phantom/PhantomPreview.svelte";
import SequenceBrowser from "./components/sequence/SequenceBrowser.svelte";
import SessionEditor from "./components/session/SessionEditor.svelte";
import type { Selection } from "./state/selection";

export interface ToolDef {
  label: string;
  // Components take `sel` and their own options as props
  component: Component<{ sel: Selection } & Record<string, unknown>>;
  /** Only with a session (e.g. the session editor). */
  needsSession?: boolean;
}

const tool = (label: string, component: unknown, needsSession = false): ToolDef => ({
  label,
  component: component as ToolDef["component"],
  needsSession,
});

export const TOOLS: Record<string, ToolDef> = {
  phantom_browser: tool("Phantom-Browser", PhantomBrowser),
  phantom_preview: tool("Phantom-Vorschau", PhantomPreview),
  fov_viewer: tool("Visueller FOV-Planer", FovViewer),
  fov_planner: tool("FOV-Planer", FovPlanner),
  sequence_browser: tool("Sequenz-Browser", SequenceBrowser),
  file_manager: tool("Dateimanager", FileManager),
  file_list: tool("Dateiliste", FileList),
  file_upload: tool("Datei-Upload", FileUpload),
  session: tool("Session-Zustand (JSON)", SessionEditor, true),
};
