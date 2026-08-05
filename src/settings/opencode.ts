/**
 * OpenCode settings adapter.
 *
 * Reads `~/.config/opencode/opencode.json`, `~/.opencode.json`, and a
 * workspace-level `opencode.json`. OpenCode spells MCP servers under `mcp` with
 * a `type` discriminator (`local` carries an argv array in `command`; `remote`
 * carries a `url`), so both shapes are projected onto the normalized spec —
 * and `mcpServers` is accepted too, since configs in the wild use both.
 */

import path from "path";
import { readSettingsJson } from "./claude.js";
import {
  emptySourceSettings,
  type AdapterContext,
  type AgentSpec,
  type McpServerSpec,
  type SourceSettings,
} from "./types.js";

interface OpenCodeMcpEntry {
  type?: string;
  command?: string | string[];
  args?: string[];
  url?: string;
  environment?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
}

interface OpenCodeSettingsFile {
  model?: string;
  mcp?: Record<string, OpenCodeMcpEntry>;
  mcpServers?: Record<string, OpenCodeMcpEntry>;
  agent?: Record<string, { description?: string; model?: string; tools?: Record<string, boolean> | string[] }>;
  permission?: Record<string, unknown>;
}

function normalizeMcpEntry(entry: OpenCodeMcpEntry): McpServerSpec | null {
  if (entry.enabled === false) return null;

  const spec: McpServerSpec = {};
  const env = entry.environment ?? entry.env;
  if (env && typeof env === "object") spec.env = env;

  if (typeof entry.url === "string") {
    spec.url = entry.url;
    return spec;
  }

  if (Array.isArray(entry.command)) {
    // OpenCode's local form is a single argv array.
    const [command, ...args] = entry.command;
    if (typeof command !== "string") return null;
    spec.command = command;
    if (args.length) spec.args = args.map(String);
    return spec;
  }

  if (typeof entry.command === "string") {
    spec.command = entry.command;
    if (Array.isArray(entry.args)) spec.args = entry.args.map(String);
    return spec;
  }

  return null;
}

function normalizeAgents(
  raw: OpenCodeSettingsFile["agent"]
): Record<string, AgentSpec> {
  const out: Record<string, AgentSpec> = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [name, entry] of Object.entries(raw)) {
    const tools = Array.isArray(entry?.tools)
      ? entry.tools.map(String)
      : entry?.tools && typeof entry.tools === "object"
        ? Object.entries(entry.tools)
            .filter(([, on]) => on)
            .map(([tool]) => tool)
        : undefined;
    out[name] = { description: entry?.description, model: entry?.model, tools };
  }

  return out;
}

/**
 * OpenCode's `permission` block maps an action to `"allow" | "ask" | "deny"`.
 * It is projected onto the same rule lists the other sources use so that a deny
 * here carries the same weight as a deny from Claude Code.
 */
function normalizePermissions(raw: OpenCodeSettingsFile["permission"]) {
  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  if (!raw || typeof raw !== "object") return { allow, deny, ask };

  for (const [action, verdict] of Object.entries(raw)) {
    if (typeof verdict !== "string") continue;
    const rule = action;
    if (verdict === "deny") deny.push(rule);
    else if (verdict === "ask") ask.push(rule);
    else if (verdict === "allow") allow.push(rule);
  }

  return { allow, deny, ask };
}

export async function loadOpenCodeSettings(ctx: AdapterContext): Promise<SourceSettings> {
  const result = emptySourceSettings("opencode");

  const files = [
    path.join(ctx.homeDir, ".config", "opencode", "opencode.json"),
    path.join(ctx.homeDir, ".opencode.json"),
    ...ctx.workspaceRoots.map((ws) => path.join(ws, "opencode.json")),
  ];

  for (const file of files) {
    const read = await readSettingsJson(file, "opencode");
    if (!read) continue;
    result.statuses.push(read.status);
    if (!read.status.ok) continue;

    const data = read.data as OpenCodeSettingsFile;
    if (typeof data?.model === "string") result.model = data.model;

    for (const source of [data?.mcp, data?.mcpServers]) {
      if (!source || typeof source !== "object") continue;
      for (const [name, entry] of Object.entries(source)) {
        const spec = normalizeMcpEntry(entry ?? {});
        if (spec) result.mcpServers[name] = spec;
      }
    }

    const permissions = normalizePermissions(data?.permission);
    result.permissions.allow.push(...permissions.allow);
    result.permissions.deny.push(...permissions.deny);
    result.permissions.ask.push(...permissions.ask);

    Object.assign(result.agents, normalizeAgents(data?.agent));
  }

  return result;
}
