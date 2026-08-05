/**
 * Grok CLI settings adapter.
 *
 * `~/.grok/settings.json` follows the same JSON conventions as Claude Code's
 * settings, so the same field names are read. A workspace-level
 * `<ws>/.grok/settings.json` overrides the home file.
 */

import path from "path";
import { readSettingsJson } from "./claude.js";
import {
  emptySourceSettings,
  type AdapterContext,
  type McpServerSpec,
  type SourceSettings,
} from "./types.js";

interface GrokSettingsFile {
  model?: string;
  defaultModel?: string;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  mcpServers?: Record<string, McpServerSpec>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function loadGrokSettings(ctx: AdapterContext): Promise<SourceSettings> {
  const result = emptySourceSettings("grok");

  const files = [
    path.join(ctx.homeDir, ".grok", "settings.json"),
    ...ctx.workspaceRoots.map((ws) => path.join(ws, ".grok", "settings.json")),
  ];

  for (const file of files) {
    const read = await readSettingsJson(file, "grok");
    if (!read) continue;
    result.statuses.push(read.status);
    if (!read.status.ok) continue;

    const data = read.data as GrokSettingsFile;
    const model = data?.model ?? data?.defaultModel;
    if (typeof model === "string") result.model = model;

    result.permissions.allow.push(...stringArray(data?.permissions?.allow));
    result.permissions.deny.push(...stringArray(data?.permissions?.deny));
    result.permissions.ask.push(...stringArray(data?.permissions?.ask));

    if (data?.mcpServers && typeof data.mcpServers === "object") {
      Object.assign(result.mcpServers, data.mcpServers);
    }
  }

  result.skillRoots.push(path.join(ctx.homeDir, ".grok", "skills"));
  return result;
}
