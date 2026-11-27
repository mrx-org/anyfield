/**
 * How a component reaches the anyfield server. Components never talk to MCP
 * directly; they get a Transport, so the same component runs
 * - in the web app (McpHttpTransport: MCP over HTTP to /mcp),
 * - as MCP App inside a chat (McpAppTransport: via the host's connection),
 * - in tests and stories (MockTransport).
 */
export interface Transport {
  /** Calls an MCP tool; resolves with its structured result, rejects with ToolCallError. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** In a chat (MCP App): post a message as the user. Absent elsewhere. */
  sendToChat?(text: string): Promise<void>;
  /** In a chat: tell the model something without a message (replaces the last). */
  setChatContext?(text: string): Promise<void>;
  /** In a chat: open a URL in the browser (the app's iframe may not navigate or download). */
  openLink?(url: string): Promise<void>;
  /** In a chat: whether the host can show the app fullscreen, and whether it does now. */
  fullscreen?(): { available: boolean; active: boolean };
  /** In a chat: ask the host for fullscreen (true) or back inline (false). */
  setFullscreen?(on: boolean): Promise<void>;
}

export class ToolCallError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

interface ToolResultLike {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

/** Structured content of an MCP CallToolResult (fastmcp wraps non-objects in {result}). */
export function unwrapResult(tool: string, result: ToolResultLike): unknown {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (result.isError) throw new ToolCallError(tool, text || `${tool} failed`);
  const sc = result.structuredContent;
  if (sc === undefined) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const keys = Object.keys(sc);
  return keys.length === 1 && keys[0] === "result" ? sc.result : sc;
}
