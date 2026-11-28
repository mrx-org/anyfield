import type { App } from "@modelcontextprotocol/ext-apps";
import { type Transport, unwrapResult } from "./transport";

/** Inside an MCP App iframe: tool calls go through the host's connection. */
export class McpAppTransport implements Transport {
  /** `client`: the app's name, sent along for the history (the host's own name comes too). */
  constructor(
    private app: App,
    private client?: string,
  ) {}

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // postMessage cannot clone Svelte state proxies: send plain JSON
    const plain = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const result = await this.app.callServerTool({
      name,
      arguments: plain,
      ...(this.client ? { _meta: { "anyfield/client": this.client } } : {}),
    });
    return unwrapResult(name, result as Parameters<typeof unwrapResult>[1]);
  }

  async sendToChat(text: string): Promise<void> {
    const r = await this.app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    if (r.isError) throw new Error("The chat did not accept the message.");
  }

  async setChatContext(text: string): Promise<void> {
    await this.app.updateModelContext({ content: [{ type: "text", text }] });
  }

  fullscreen(): { available: boolean; active: boolean } {
    const ctx = this.app.getHostContext();
    return {
      available: !!ctx?.availableDisplayModes?.includes("fullscreen"),
      active: ctx?.displayMode === "fullscreen",
    };
  }

  async setFullscreen(on: boolean): Promise<void> {
    await this.app.requestDisplayMode({ mode: on ? "fullscreen" : "inline" });
  }

  async openLink(url: string): Promise<void> {
    const r = await this.app.openLink({ url });
    if (r.isError) throw new Error("The chat did not open the link.");
  }
}
