// Dev only (`pnpm dev`, then /dev/app-host.html?key=<session key>): plays the chat
// host for the MCP App, the way claude.ai does. It calls `open_fov_planner`,
// loads the app's resource into a sandboxed iframe and forwards its tool calls.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const status = document.getElementById("status")!;
const iframe = document.getElementById("app") as HTMLIFrameElement;
const key = new URLSearchParams(location.search).get("key") ?? "";

const client = new Client({ name: "anyfield-test-host", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)));

const tools = await client.listTools();
const uri = (tools.tools.find((t) => t.name === "open_fov_planner")?._meta as { ui?: { resourceUri?: string } })?.ui
  ?.resourceUri;
const resource = await client.readResource({ uri: uri! });
const html = (resource.contents[0] as { text: string }).text;

// ext-apps is built on MCP SDK v2, the web app on v1: forward tool calls by hand
const bridge = new AppBridge(null, { name: "anyfield-test-host", version: "0.0.0" }, { serverTools: {} });
bridge.oncalltool = async (params) =>
  (await client.callTool(params)) as Awaited<ReturnType<NonNullable<typeof bridge.oncalltool>>>;
const args = { session_key: key };
bridge.oninitialized = async () => {
  status.textContent = "App verbunden";
  await bridge.sendToolInput({ arguments: args });
  const result = await client.callTool({ name: "open_fov_planner", arguments: args });
  await bridge.sendToolResult(result as Parameters<typeof bridge.sendToolResult>[0]);
};
iframe.srcdoc = html;
await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
status.textContent = "verbinde …";
