/**
 * Codex settings adapter.
 *
 * `~/.codex/config.toml` is parsed with a deliberately small TOML subset:
 * comments, `[table]` and `[a.b."quoted"]` headers, and `key = value` for
 * strings, numbers, booleans, and inline arrays. Codex configs use nothing
 * beyond that, and a full TOML parser would be a dependency added for a handful
 * of keys.
 *
 * Anything the subset cannot represent — inline tables, multi-line strings,
 * arrays of tables — is skipped rather than guessed at, so a value is either
 * read correctly or not read at all.
 */

import fs from "fs/promises";
import path from "path";
import {
  emptySourceSettings,
  type AdapterContext,
  type McpServerSpec,
  type SourceSettings,
} from "./types.js";

type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/** Split a dotted TOML key path, honouring quoted segments. */
function splitKeyPath(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

function parseTomlValue(raw: string): TomlValue | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;

  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];

    const items: TomlValue[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let depth = 0;

    for (const ch of inner) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (ch === "," && depth === 0) {
        const value = parseTomlValue(current);
        if (value !== undefined) items.push(value);
        current = "";
        continue;
      }
      current += ch;
    }

    const last = parseTomlValue(current);
    if (last !== undefined) items.push(last);
    return items;
  }

  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);

  // Inline tables and anything else exotic: left unread on purpose.
  if (text.startsWith("{")) return undefined;

  return text;
}

/** Strip a trailing `#` comment without cutting inside a quoted string. */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return text.slice(0, i);
    }
  }
  return text;
}

export function parseMinimalToml(content: string): TomlTable {
  const root: TomlTable = {};
  // The current table is tracked by path, not by reference, so a dotted key
  // inside a table nests under the right parent without searching for it.
  let tablePath: string[] = [];
  let skipping = false;

  const descend = (segments: string[]): TomlTable => {
    let node = root;
    for (const segment of segments) {
      const next = node[segment];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        node = next as TomlTable;
      } else {
        const created: TomlTable = {};
        node[segment] = created;
        node = created;
      }
    }
    return node;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[[")) {
      // Arrays of tables are outside the subset: skip their keys entirely
      // rather than folding them into the previous table.
      skipping = true;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      tablePath = splitKeyPath(line.slice(1, -1));
      skipping = false;
      descend(tablePath);
      continue;
    }

    if (skipping) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const keyPath = splitKeyPath(line.slice(0, eq));
    if (!keyPath.length) continue;

    const value = parseTomlValue(stripComment(line.slice(eq + 1)));
    if (value === undefined) continue;

    const leaf = keyPath.pop() as string;
    descend([...tablePath, ...keyPath])[leaf] = value;
  }

  return root;
}

function asStringArray(value: TomlValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function asStringMap(value: TomlValue | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function loadCodexSettings(ctx: AdapterContext): Promise<SourceSettings> {
  const result = emptySourceSettings("codex");
  const file = path.join(ctx.homeDir, ".codex", "config.toml");
  const loadedAt = new Date().toISOString();

  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    // Codex not installed; still contribute the skill root, which costs nothing
    // if the directory is absent.
    result.skillRoots.push(path.join(ctx.homeDir, ".codex", "skills"));
    return result;
  }

  let parsed: TomlTable;
  try {
    parsed = parseMinimalToml(content);
  } catch (error) {
    result.statuses.push({
      id: "codex",
      path: file,
      loadedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  result.statuses.push({ id: "codex", path: file, loadedAt, ok: true });

  if (typeof parsed.model === "string") result.model = parsed.model;

  const servers = parsed.mcp_servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [name, raw] of Object.entries(servers as TomlTable)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as TomlTable;
      const spec: McpServerSpec = {};
      if (typeof entry.command === "string") spec.command = entry.command;
      if (typeof entry.url === "string") spec.url = entry.url;
      const args = asStringArray(entry.args);
      if (args) spec.args = args;
      const env = asStringMap(entry.env);
      if (env) spec.env = env;
      if (spec.command || spec.url) result.mcpServers[name] = spec;
    }
  }

  result.skillRoots.push(path.join(ctx.homeDir, ".codex", "skills"));

  // Codex records project trust in config.toml. It is read for reporting only:
  // trusting a project in Codex must not silently widen this host's writes.
  const agentsFile = path.join(ctx.homeDir, ".codex", "AGENTS.md");
  try {
    await fs.access(agentsFile);
    result.agents["codex-agents-md"] = { description: "Codex global AGENTS.md", path: agentsFile };
  } catch {
    /* absent */
  }

  return result;
}
