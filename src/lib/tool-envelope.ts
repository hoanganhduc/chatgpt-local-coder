/**
 * Every tool failure leaves this host as structured data, not as a sentence.
 *
 * Tools report success through `structuredContent` — `{ ok: true, data }` — but a
 * tool that throws never reaches that helper. The SDK turns the exception into a
 * result carrying `isError` and a bare string, so a client reading `ok` finds no
 * `ok` at all. A model that cannot see a denial as a denial retries the same
 * call, which is how a refused write turned into three minutes of polling and a
 * report that the connector had gone away.
 *
 * Wrapping registration rather than each tool covers the proxied upstream tools
 * too, and means a tool added later cannot forget. `isError` is kept: the flag
 * tells the client the call did not succeed, the body tells the model why.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toolError } from "./tool-result.js";

export function applyErrorEnvelope(server: McpServer): void {
  const original = server.registerTool.bind(server);

  server.registerTool = ((name: string, config: unknown, callback: unknown) => {
    const invoke = callback as (...args: unknown[]) => unknown;

    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      try {
        return await invoke(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...toolError(String(name), message), isError: true };
      }
    };

    return original(name as never, config as never, wrapped as never);
  }) as typeof server.registerTool;
}
