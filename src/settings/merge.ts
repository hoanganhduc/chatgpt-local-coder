/**
 * Merging imported settings, and the rule semantics that follow from it.
 *
 * Precedence, lowest to highest: codex < grok < opencode < claude < host config.
 * Every override is recorded in `conflicts` so `settings_status` can say why a
 * value won rather than leaving the user to guess.
 *
 * The permission semantics are deliberately asymmetric:
 *
 *   - An imported `deny` is always applied. A rule the user wrote to stop
 *     `rm -rf /` in one agent should stop it here too.
 *   - An imported `allow` never widens this host's permission profile. It can
 *     only reduce prompting inside what the profile already permits. Importing
 *     another tool's config must not be a way to escape the workspace boundary.
 *
 * Deny therefore merges as a union across every source, while allow is advisory
 * and is reported as such.
 */

import path from "path";
import type {
  NormalizedSettings,
  SettingsConflict,
  SettingsSourceId,
  SourceSettings,
} from "./types.js";

/** Lowest precedence first — the merge applies sources in this order. */
export const SOURCE_PRECEDENCE: SettingsSourceId[] = ["codex", "grok", "opencode", "claude"];

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.trim()))];
}

export interface MergeOptions {
  /** Host-config values, which outrank every imported source. */
  host?: { model?: string; skillRoots?: string[] };
}

export function mergeSettings(sources: SourceSettings[], opts: MergeOptions = {}): NormalizedSettings {
  const ordered = SOURCE_PRECEDENCE.map((id) => sources.find((s) => s.id === id)).filter(
    (s): s is SourceSettings => Boolean(s)
  );

  const merged: NormalizedSettings = {
    sources: [],
    permissions: { allow: [], deny: [], ask: [] },
    mcpServers: {},
    hooks: {},
    agents: {},
    skillRoots: [],
    conflicts: [],
  };

  // Who last set each single-valued or keyed entry, so conflicts can name both
  // the winner and everyone it displaced.
  const owners = new Map<string, SettingsSourceId[]>();
  const conflicts: SettingsConflict[] = [];

  const claim = (key: string, id: SettingsSourceId): void => {
    const prior = owners.get(key) ?? [];
    if (prior.length) conflicts.push({ key, winner: id, losers: [...prior] });
    owners.set(key, [...prior, id]);
  };

  for (const source of ordered) {
    merged.sources.push(...source.statuses);

    if (source.model) {
      claim("model", source.id);
      merged.model = source.model;
    }

    for (const [name, spec] of Object.entries(source.mcpServers)) {
      claim(`mcpServers.${name}`, source.id);
      merged.mcpServers[name] = spec;
    }

    for (const [event, matchers] of Object.entries(source.hooks)) {
      claim(`hooks.${event}`, source.id);
      merged.hooks[event] = matchers;
    }

    for (const [name, spec] of Object.entries(source.agents)) {
      claim(`agents.${name}`, source.id);
      merged.agents[name] = spec;
    }

    // Rule lists are unioned, not overwritten: a deny from a low-precedence
    // source has to survive a high-precedence source that does not mention it.
    merged.permissions.allow.push(...source.permissions.allow);
    merged.permissions.deny.push(...source.permissions.deny);
    merged.permissions.ask.push(...source.permissions.ask);

    merged.skillRoots.push(...source.skillRoots);
  }

  if (opts.host?.model) {
    if (owners.has("model")) {
      conflicts.push({ key: "model", winner: "host", losers: owners.get("model") ?? [] });
    }
    merged.model = opts.host.model;
  }

  merged.skillRoots.push(...(opts.host?.skillRoots ?? []));

  merged.permissions.allow = unique(merged.permissions.allow);
  merged.permissions.deny = unique(merged.permissions.deny);
  merged.permissions.ask = unique(merged.permissions.ask);
  merged.skillRoots = unique(merged.skillRoots.map((r) => path.resolve(r)));
  merged.conflicts = conflicts;

  return merged;
}

// ---------------------------------------------------------------- rule matching

/**
 * A permission rule is either a bare tool name (`Bash`) or a tool name with a
 * pattern (`Bash(rm -rf /)`, `Edit(/**\/.env)`).
 *
 * The pattern is a glob, interpreted differently for the two kinds of argument
 * a rule can be matched against:
 *
 *   - Against a **path**, `*` stays inside one segment and `**` crosses
 *     separators, so `Edit(/etc/*)` does not reach `/etc/a/b`.
 *   - Against a **command line**, `*` matches anything. A command is not a path
 *     and has no segments, so `Bash(curl * | sh)` has to survive a URL
 *     containing slashes.
 *
 * `?` matches a single character in both. Everything else is literal.
 */
export interface ParsedRule {
  tool: string;
  pattern?: string;
  raw: string;
}

export function parseRule(raw: string): ParsedRule | null {
  const text = raw.trim();
  if (!text) return null;

  const open = text.indexOf("(");
  if (open < 0 || !text.endsWith(")")) {
    return { tool: text, raw: text };
  }

  return { tool: text.slice(0, open).trim(), pattern: text.slice(open + 1, -1).trim(), raw: text };
}

type ArgumentKind = "path" | "command";

function globToRegExp(pattern: string, kind: ArgumentKind): RegExp {
  const anySegment = kind === "path" ? "[^/\\\\]*" : "[\\s\\S]*";
  const oneChar = kind === "path" ? "[^/\\\\]" : "[\\s\\S]";
  let out = "";

  // A rule written with a POSIX root also matches a Windows drive-rooted path,
  // so a `deny` a user wrote on Linux still holds when the host runs on Windows.
  let start = 0;
  if (kind === "path" && (pattern[0] === "/" || pattern[0] === "\\")) {
    out += "(?:[A-Za-z]:)?[/\\\\]";
    start = 1;
  }

  for (let i = start; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += "[\\s\\S]*";
        i++;
        // Absorb a separator directly after `**` so `/**/x` also matches `/x`.
        if (pattern[i + 1] === "/" || pattern[i + 1] === "\\") i++;
      } else {
        out += anySegment;
      }
      continue;
    }
    if (ch === "?") {
      out += oneChar;
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${out}$`);
}

/**
 * Host tool names mapped onto the tool vocabulary these configs are written in.
 * A rule the user wrote as `Bash(...)` has to reach `run_command` here, or the
 * import would look like it worked while enforcing nothing.
 */
const TOOL_ALIASES: Record<string, string[]> = {
  run_command: ["Bash", "Shell", "run_command", "bash"],
  start_process: ["Bash", "Shell", "start_process", "bash"],
  shell_status: ["Bash", "Shell", "shell_status"],
  write_file: ["Write", "Edit", "write_file"],
  edit_file: ["Edit", "Write", "edit_file"],
  multi_edit: ["Edit", "Write", "MultiEdit", "multi_edit"],
  apply_patch: ["Edit", "Write", "apply_patch"],
  create_directory: ["Write", "create_directory"],
  move_file: ["Write", "Edit", "move_file"],
  copy_file: ["Write", "copy_file"],
  delete_file: ["Write", "Edit", "delete_file"],
  read_text_file: ["Read", "read_text_file"],
  skill_run: ["Bash", "Shell", "skill_run"],
};

/** Tools whose argument is a command line rather than a path. */
const COMMAND_TOOLS = new Set(["run_command", "start_process", "shell_status", "skill_run"]);

function argumentKind(tool: string): ArgumentKind {
  return COMMAND_TOOLS.has(tool) ? "command" : "path";
}

function ruleAppliesToTool(rule: ParsedRule, tool: string): boolean {
  if (rule.tool === "*") return true;
  const aliases = TOOL_ALIASES[tool] ?? [tool];
  return aliases.some((alias) => alias.toLowerCase() === rule.tool.toLowerCase());
}

function ruleMatchesArgument(rule: ParsedRule, argument: string, kind: ArgumentKind): boolean {
  // A bare tool rule covers every invocation of that tool.
  if (rule.pattern === undefined || rule.pattern === "") return true;

  const pattern = rule.pattern;
  const candidates = new Set([argument]);
  if (kind === "path") {
    // Compare in both separator styles so a rule written on one OS still
    // matches a path produced on the other.
    candidates.add(argument.replace(/\\/g, "/"));
    candidates.add(argument.replace(/\//g, "\\"));
  }

  const regex = globToRegExp(pattern, kind);
  for (const candidate of candidates) {
    if (regex.test(candidate)) return true;
  }

  // A pattern with no wildcard is also honoured as a prefix, which is how
  // `Bash(git push)` is meant to read: the command plus its arguments.
  if (!/[*?]/.test(pattern)) {
    for (const candidate of candidates) {
      if (candidate === pattern || candidate.startsWith(`${pattern} `)) return true;
    }
  }

  return false;
}

export type RuleVerdict = { decision: "deny" | "ask"; rule: string } | null;

/**
 * Evaluate imported rules for one tool invocation.
 *
 * Only `deny` and `ask` are returned. `allow` is intentionally not consulted:
 * an imported allow cannot grant anything the host profile does not already
 * grant, so treating it as a verdict here would be the widening this design
 * rules out.
 */
export function evaluateRules(
  permissions: { deny: string[]; ask: string[] },
  tool: string,
  argument: string
): RuleVerdict {
  const kind = argumentKind(tool);

  for (const raw of permissions.deny) {
    const rule = parseRule(raw);
    if (rule && ruleAppliesToTool(rule, tool) && ruleMatchesArgument(rule, argument, kind)) {
      return { decision: "deny", rule: rule.raw };
    }
  }

  for (const raw of permissions.ask) {
    const rule = parseRule(raw);
    if (rule && ruleAppliesToTool(rule, tool) && ruleMatchesArgument(rule, argument, kind)) {
      return { decision: "ask", rule: rule.raw };
    }
  }

  return null;
}
