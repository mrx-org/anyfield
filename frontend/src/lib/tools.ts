// The tools a workspace panel can show: name (its MCP tool without `open_`, as in
// the state's `layout`), a label and a Lucide icon for the "add tool" buttons, and
// the component. The
// backend's list is `layout.TOOLS`. The MCP Apps each import their own component
// instead: importing this would put every tool (and NiiVue) into every app.
import type { Component } from "svelte";
import AudioWaveform from "@lucide/svelte/icons/audio-waveform";
import Braces from "@lucide/svelte/icons/braces";
import Brain from "@lucide/svelte/icons/brain";
import Files from "@lucide/svelte/icons/files";
import FolderOpen from "@lucide/svelte/icons/folder-open";
import Move3d from "@lucide/svelte/icons/move-3d";
import ScanEye from "@lucide/svelte/icons/scan-eye";
import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
import Upload from "@lucide/svelte/icons/upload";
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
  icon: Component<{ class?: string; "aria-hidden"?: boolean | "true" }>;
  // Components take `sel` and their own options as props
  component: Component<{ sel: Selection } & Record<string, unknown>>;
  /** Only with a session (e.g. the session editor). */
  needsSession?: boolean;
}

const tool = (label: string, icon: unknown, component: unknown, needsSession = false): ToolDef => ({
  label,
  icon: icon as ToolDef["icon"],
  component: component as ToolDef["component"],
  needsSession,
});

export const TOOLS: Record<string, ToolDef> = {
  phantom_browser: tool("Phantom-Browser", Brain, PhantomBrowser),
  phantom_preview: tool("Phantom-Vorschau", ScanEye, PhantomPreview),
  fov_viewer: tool("Visueller FOV-Planer", Move3d, FovViewer),
  fov_planner: tool("FOV-Planer", SlidersHorizontal, FovPlanner),
  sequence_browser: tool("Sequenz-Browser", AudioWaveform, SequenceBrowser),
  file_manager: tool("Dateimanager", FolderOpen, FileManager),
  file_list: tool("Dateiliste", Files, FileList),
  file_upload: tool("Datei-Upload", Upload, FileUpload),
  session: tool("Session-Zustand (JSON)", Braces, SessionEditor, true),
};
