/**
 * Wiring the hooks engine into tool dispatch.
 *
 * `applyHookWrapper` replaces `server.registerTool` so every tool registered
 * afterwards runs inside the PreToolUse / PostToolUse pair. Doing it here rather
 * than in each tool module means a hook applies to proxied upstream tools too,
 * and no future tool can forget to participate.
 *
 * When no hook matches, the wrapper falls straight through to the original
 * handler and the result is returned untouched.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDefaultCwd } from "../lib/path-security.js";
import { toolError } from "../lib/tool-result.js";
import { hasHooks, runHooks, type HookReport } from "./engine.js";

type ToolResultLike = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

function hookNotes(reports: HookReport[]): Array<Record<string, unknown>> {
  // Internal hooks that ran cleanly are this host's normal behaviour and are
  // not worth reporting; command hooks and failures are.
  return reports.flatMap((report) =>
    report.results
      .filter((h) => h.source === "command" || h.error || h.skipped)
      .map((h) => ({ event: report.event, ...h }))
  );
}

function applyHookOutput(result: unknown, reports: HookReport[]): unknown {
  const enrich: Record<string, unknown> = {};
  for (const report of reports) if (report.enrich) Object.assign(enrich, report.enrich);
  const notes = hookNotes(reports);
  if (!Object.keys(enrich).length && !notes.length) return result;

  const typed = result as ToolResultLike;
  const structured = typed?.structuredContent;
  if (!structured || typeof structured !== "object") return result;

  const data = { ...((structured.data as Record<string, unknown>) ?? {}), ...enrich };
  if (notes.length) data.hooks = notes;
  const payload = { ...structured, data };

  const single = typed.content?.length === 1 && typed.content[0]?.type === "text";
  return {
    ...typed,
    structuredContent: payload,
    content: single ? [{ type: "text", text: JSON.stringify(payload, null, 2) }] : typed.content,
  };
}

export function applyHookWrapper(server: McpServer): void {
  const original = server.registerTool.bind(server);

  server.registerTool = ((name: string, config: Record<string, unknown>, callback: Function) => {
    const takesArgs = config?.inputSchema !== undefined;

    const wrapped = async (...cbArgs: unknown[]): Promise<unknown> => {
      const input = takesArgs ? cbArgs[0] : undefined;
      const extra = (takesArgs ? cbArgs[1] : cbArgs[0]) as { sessionId?: string } | undefined;
      const base = { tool: name, input, sessionId: extra?.sessionId, cwd: getDefaultCwd() };

      const reports: HookReport[] = [];

      if (hasHooks("PreToolUse", name)) {
        const pre = await runHooks({ ...base, event: "PreToolUse" });
        reports.push(pre);
        if (pre.blocked) {
          return toolError(
            name,
            `Blocked by a PreToolUse hook (${pre.blocked.hook}): ${pre.blocked.reason}`,
            { hooks: hookNotes(reports) }
          );
        }
      }

      const result = await callback(...cbArgs);

      if (hasHooks("PostToolUse", name)) {
        reports.push(await runHooks({ ...base, event: "PostToolUse", result }));
      }

      return applyHookOutput(result, reports);
    };

    return original(name as never, config as never, wrapped as never);
  }) as typeof server.registerTool;
}
