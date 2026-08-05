/**
 * Claude Code settings adapter.
 *
 * Reads, in increasing order of specificity:
 *   ~/.claude/settings.json
 *   <ws>/.claude/settings.json
 *   <ws>/.claude/settings.local.json
 * plus subagent definitions from ~/.claude/agents/*.md and <ws>/.claude/agents/*.md.
 *
 * Every file is optional. A file that fails to parse is reported through its
 * status entry rather than aborting the load — one broken settings file should
 * not take down the host.
 */

import fs from "fs/promises";
import path from "path";
import { parseSkillFile } from "../skills/frontmatter.js";
import {
  emptySourceSettings,
  type AdapterContext,
  type AgentSpec,
  type HookMatcher,
  type McpServerSpec,
  type SettingsSourceId,
  type SettingsSourceStatus,
  type SourceSettings,
} from "./types.js";

interface ClaudeSettingsFile {
  model?: string;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: string };
  mcpServers?: Record<string, McpServerSpec>;
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>>;
}

/**
 * Shared JSON reader for every JSON-backed source. Returns null when the file
 * simply is not there, and a failed status when it exists but will not parse.
 */
async function readJson(
  file: string,
  id: SettingsSourceId
): Promise<{ data?: unknown; status: SettingsSourceStatus } | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    // Absent is the normal case for an optional source, not an error worth
    // reporting.
    return null;
  }

  const loadedAt = new Date().toISOString();
  try {
    return { data: JSON.parse(text), status: { id, path: file, loadedAt, ok: true } };
  } catch (error) {
    return {
      status: {
        id,
        path: file,
        loadedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function normalizeHooks(
  raw: ClaudeSettingsFile["hooks"]
): Record<string, HookMatcher[]> {
  const out: Record<string, HookMatcher[]> = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [event, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    const matchers: HookMatcher[] = [];

    for (const entry of entries) {
      const actions = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const hooks = actions
        .filter((a) => typeof a?.command === "string" && a.command.trim())
        .map((a) => ({
          type: typeof a.type === "string" ? a.type : "command",
          command: String(a.command),
          timeoutSec: typeof a.timeout === "number" ? a.timeout : undefined,
        }));
      if (hooks.length) {
        matchers.push({ matcher: typeof entry?.matcher === "string" ? entry.matcher : undefined, hooks });
      }
    }

    if (matchers.length) out[event] = matchers;
  }

  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function readAgentsDir(dir: string): Promise<Record<string, AgentSpec>> {
  const out: Record<string, AgentSpec> = {};

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(dir, entry.name);

    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }

    // Agent definitions use the same frontmatter convention as skills.
    const { frontmatter } = parseSkillFile(content);
    const name = frontmatter.name?.trim() || entry.name.replace(/\.md$/, "");
    out[name] = {
      description: frontmatter.description,
      model: frontmatter.model,
      tools: frontmatter.allowedTools ?? stringArray(frontmatter.raw.tools),
      path: file,
    };
  }

  return out;
}

export async function loadClaudeSettings(ctx: AdapterContext): Promise<SourceSettings> {
  const result = emptySourceSettings("claude");

  const files = [
    path.join(ctx.homeDir, ".claude", "settings.json"),
    ...ctx.workspaceRoots.map((ws) => path.join(ws, ".claude", "settings.json")),
    ...ctx.workspaceRoots.map((ws) => path.join(ws, ".claude", "settings.local.json")),
  ];

  for (const file of files) {
    const read = await readJson(file, "claude");
    if (!read) continue;
    result.statuses.push(read.status);
    if (!read.status.ok) continue;

    const data = read.data as ClaudeSettingsFile;
    if (typeof data?.model === "string") result.model = data.model;

    result.permissions.allow.push(...stringArray(data?.permissions?.allow));
    result.permissions.deny.push(...stringArray(data?.permissions?.deny));
    result.permissions.ask.push(...stringArray(data?.permissions?.ask));

    if (data?.mcpServers && typeof data.mcpServers === "object") {
      Object.assign(result.mcpServers, data.mcpServers);
    }

    // A later file replaces an event wholesale rather than appending, matching
    // how Claude Code resolves overlapping hook definitions.
    Object.assign(result.hooks, normalizeHooks(data?.hooks));
  }

  const agentDirs = [
    path.join(ctx.homeDir, ".claude", "agents"),
    ...ctx.workspaceRoots.map((ws) => path.join(ws, ".claude", "agents")),
  ];
  for (const dir of agentDirs) {
    Object.assign(result.agents, await readAgentsDir(dir));
  }

  for (const ws of ctx.workspaceRoots) result.skillRoots.push(path.join(ws, ".claude", "skills"));
  result.skillRoots.push(path.join(ctx.homeDir, ".claude", "skills"));

  return result;
}

export { readJson as readSettingsJson };
