import type { App } from "@modelcontextprotocol/ext-apps";
import { type Transport, unwrapResult } from "./transport";

/** Inside an MCP App iframe: tool calls go through the host's connection. */
export class McpAppTransport implements Transport {
  constructor(private app: App) {}

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // postMessage cannot clone Svelte state proxies: send plain JSON
    const plain = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const result = await this.app.callServerTool({ name, arguments: plain });
    return unwrapResult(name, result as Parameters<typeof unwrapResult>[1]);
  }
}
