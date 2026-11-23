// Dev only (`pnpm dev`, then /dev/app-host.html[?key=<session key>][&tool=open_phantom_browser][&maxHeight=500][&<tool argument>=…]): plays the chat
// host for the MCP App, the way claude.ai does. It calls `open_fov_planner`,
// loads the app's resource into a sandboxed iframe and forwards its tool calls.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const status = document.getElementById("status")!;
const iframe = document.getElementById("app") as HTMLIFrameElement;
const query = new URLSearchParams(location.search);
const key = query.get("key") ?? "";
const toolName = query.get("tool") ?? "open_fov_planner";

const client = new Client({ name: "anyfield-test-host", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)));

const tools = await client.listTools();
const uri = (tools.tools.find((t) => t.name === toolName)?._meta as { ui?: { resourceUri?: string } })?.ui
  ?.resourceUri;
const resource = await client.readResource({ uri: uri! });
const html = (resource.contents[0] as { text: string }).text;

// ext-apps is built on MCP SDK v2, the web app on v1: forward tool calls by hand
// `&maxHeight=<px>` limits the app's height, as a host may (containerDimensions)
const maxHeight = Number(query.get("maxHeight")) || undefined;
const bridge = new AppBridge(
  null,
  { name: "anyfield-test-host", version: "0.0.0" },
  { serverTools: {} },
  { hostContext: { containerDimensions: { maxHeight } } },
);
bridge.oncalltool = async (params) =>
  (await client.callTool(params)) as Awaited<ReturnType<NonNullable<typeof bridge.oncalltool>>>;
// Every other query parameter is a tool argument, e.g. for the preview without a session:
// ?tool=open_phantom_preview&collection=endres-brainweb-001&name=subj04-3T-1mm.json&property=T1
const reserved = new Set(["key", "tool", "maxHeight"]);
const args: Record<string, string> = Object.fromEntries([...query].filter(([k]) => !reserved.has(k)));
if (key) args.session_key = key;
// Without a session the app hands its result back to the chat: show it here
bridge.onmessage = async (params) => {
  status.textContent = `Nachricht an den Chat: ${JSON.stringify(params.content)}`;
  return {};
};
bridge.onupdatemodelcontext = async (params) => {
  console.info("anyfield test host: model context", params.content);
  return {};
};
bridge.oninitialized = async () => {
  status.textContent = "App verbunden";
  await bridge.sendToolInput({ arguments: args });
  const result = await client.callTool({ name: toolName, arguments: args });
  await bridge.sendToolResult(result as Parameters<typeof bridge.sendToolResult>[0]);
};
// Like claude.ai: the iframe takes the height the app reports
bridge.onsizechange = ({ height }) => {
  if (height !== undefined) iframe.style.height = `${Math.min(height, maxHeight ?? Infinity)}px`;
};
iframe.srcdoc = html;
await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
status.textContent = "verbinde …";
