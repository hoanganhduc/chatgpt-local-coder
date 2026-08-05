/**
 * `skills`, `settings`, and `config` — the read-mostly commands.
 *
 * These exist so the same engines the MCP tools use can be driven from a
 * terminal, which is how you check what the host will see before starting it.
 */

import fs from "fs/promises";

import { loadConfig, writeUserConfig } from "../../config/load.js";
import { configFilePath } from "../../config/paths.js";
import { partialHostConfigSchema, type PartialHostConfig } from "../../config/schema.js";
import { loadSettings, resetSettings } from "../../settings/index.js";
import { loadSkillRegistry, skillSupportsPlatform } from "../../skills/registry.js";
import { runSkill } from "../../skills/run.js";
import { reportPaths } from "../doctor.js";
import { flag, integer, parseCommand, UsageError, type CommandSpec } from "../args.js";

export const SKILLS_SUBCOMMANDS = ["list", "read", "run"];
export const SETTINGS_SUBCOMMANDS = ["show", "refresh"];
export const CONFIG_SUBCOMMANDS = ["get", "set", "path"];

export const SKILLS_SPEC: CommandSpec = {
  name: "skills",
  summary: "List, read, or run a discovered skill.",
  usage: `<${SKILLS_SUBCOMMANDS.join("|")}> [name] [-- args...]`,
  options: {
    json: { type: "boolean", description: "Emit JSON." },
    cwd: { type: "string", description: "Working directory for `run`.", placeholder: "path" },
    timeout: { type: "string", description: "Runtime cap in seconds for `run`.", placeholder: "sec" },
  },
};

export const SETTINGS_SPEC: CommandSpec = {
  name: "settings",
  summary: "Show what is imported from the other agents' configuration files.",
  usage: `<${SETTINGS_SUBCOMMANDS.join("|")}>`,
  detail: "Source files are read, never written. Imported deny rules are enforced; imported allow rules never widen the profile.",
  options: { json: { type: "boolean", description: "Emit JSON." } },
};

export const CONFIG_SPEC: CommandSpec = {
  name: "config",
  summary: "Read or modify the host configuration.",
  usage: `<${CONFIG_SUBCOMMANDS.join("|")}> [key] [value]`,
  detail:
    "Keys are dotted paths into config.json, e.g. `tunnel.alias` or `skills.allowExecution`.\n" +
    "Values are parsed as JSON when possible and taken as a string otherwise, so\n" +
    "`config set port 4000` stores a number and `config set permissionProfile open` stores a string.",
  options: { json: { type: "boolean", description: "Emit JSON." } },
};

async function registryFor(cwd: string) {
  const { config } = loadConfig({ cwd });
  resetSettings();
  const settings = await loadSettings({
    workspaceRoots: config.workspaceRoots,
    sources: config.settings.sources,
    enabled: config.settings.import,
    host: { skillRoots: config.skills.roots },
  });
  const registry = await loadSkillRegistry({
    workspaceRoots: config.workspaceRoots,
    extraRoots: [...settings.skillRoots, ...config.skills.roots],
    enabled: config.skills.enabled,
    disabled: config.skills.disabled,
  });
  return { config, settings, registry };
}

export async function runSkills(argv: string[], cwd = process.cwd()): Promise<number> {
  // Everything after `--` belongs to the skill, not to this parser.
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  const parsed = parseCommand(own, SKILLS_SPEC);
  const sub = parsed.positionals[0];
  if (!sub) throw new UsageError(`skills needs a subcommand: ${SKILLS_SUBCOMMANDS.join(", ")}`, SKILLS_SPEC);
  if (!SKILLS_SUBCOMMANDS.includes(sub)) throw new UsageError(`unknown skills subcommand "${sub}"`, SKILLS_SPEC);

  const { config, registry } = await registryFor(cwd);
  const asJson = flag(parsed.values, "json");

  if (sub === "list") {
    if (asJson) {
      console.log(JSON.stringify({ skills: registry.skills, roots: registry.roots, shadowed: registry.shadowed }, null, 2));
      return 0;
    }
    if (!registry.skills.length) {
      console.log("No skills discovered.");
      console.log(`Roots searched: ${registry.roots.map((r) => r.path).join(", ") || "none"}`);
      return 1;
    }
    const width = Math.max(...registry.skills.map((s) => s.name.length));
    for (const skill of registry.skills) {
      const unsupported = skillSupportsPlatform(skill) ? "" : "  (unsupported on this platform)";
      console.log(`  ${skill.name.padEnd(width + 2)}${skill.description}${unsupported}`);
    }
    console.log("");
    console.log(`${registry.skills.length} skill(s) from ${registry.roots.length} root(s)` +
      (registry.shadowed.length ? `, ${registry.shadowed.length} shadowed` : ""));
    return 0;
  }

  const name = parsed.positionals[1];
  if (!name) throw new UsageError(`skills ${sub} needs a skill name`, SKILLS_SPEC);

  const found = registry.skills.find((s) => s.name === name);
  if (!found) {
    console.error(`No skill named "${name}". Run \`chatgpt-local-coder skills list\`.`);
    return 1;
  }

  if (sub === "read") {
    const body = await fs.readFile(found.file, "utf-8");
    if (asJson) console.log(JSON.stringify({ ...found, body }, null, 2));
    else console.log(body);
    return 0;
  }

  const result = await runSkill(name, {
    args: passthrough,
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    timeoutSec: integer(parsed.values, "timeout") ?? config.skills.maxRuntimeSec,
    allowExecution: config.skills.allowExecution,
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    if (result.timedOut) console.error(`Skill "${name}" exceeded its runtime cap and was killed.`);
  }
  return result.exitCode ?? 1;
}

export async function runSettings(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, SETTINGS_SPEC);
  const sub = parsed.positionals[0] ?? "show";
  if (!SETTINGS_SUBCOMMANDS.includes(sub)) throw new UsageError(`unknown settings subcommand "${sub}"`, SETTINGS_SPEC);

  const { settings } = await registryFor(cwd);

  if (flag(parsed.values, "json")) {
    console.log(JSON.stringify(settings, null, 2));
    return settings.sources.every((s) => s.ok) ? 0 : 1;
  }

  console.log("Sources:");
  for (const source of settings.sources) {
    console.log(`  ${source.ok ? "ok  " : "FAIL"}  ${source.id.padEnd(9)}${source.path}${source.ok ? "" : ` — ${source.error}`}`);
  }

  console.log("");
  console.log(`Permissions: ${settings.permissions.deny.length} deny (enforced), ${settings.permissions.ask.length} ask (reported only)`);
  for (const rule of settings.permissions.deny) console.log(`  deny  ${rule}`);
  console.log("  Imported allow rules never widen the host profile; they only reduce prompting inside it.");

  const mcp = Object.keys(settings.mcpServers);
  console.log("");
  console.log(`MCP servers: ${mcp.length ? mcp.join(", ") : "none"}`);

  const hooks = Object.entries(settings.hooks).filter(([, v]) => v.length);
  console.log(`Hooks: ${hooks.length ? hooks.map(([e, v]) => `${e}×${v.length}`).join(" ") : "none"}`);

  const agents = Object.keys(settings.agents);
  console.log(`Agents: ${agents.length ? agents.join(", ") : "none"}`);
  console.log(`Model: ${settings.model ?? "not set"}`);
  console.log(`Skill roots: ${settings.skillRoots.join(", ") || "none"}`);

  if (settings.conflicts.length) {
    console.log("");
    console.log("Conflicts (higher-precedence source won):");
    for (const conflict of settings.conflicts) {
      console.log(`  ${conflict.key}: ${conflict.winner} over ${conflict.losers.join(", ")}`);
    }
  }

  return settings.sources.every((s) => s.ok) ? 0 : 1;
}

/** Walk a dotted key into a nested object. */
function readPath(source: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}

/** Build `{a: {b: value}}` from `a.b`. */
function nest(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".");
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cursor[parts[i]] = {};
    cursor = cursor[parts[i]] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return root;
}

export async function runConfigCommand(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, CONFIG_SPEC);
  const sub = parsed.positionals[0];
  if (!sub) throw new UsageError(`config needs a subcommand: ${CONFIG_SUBCOMMANDS.join(", ")}`, CONFIG_SPEC);
  if (!CONFIG_SUBCOMMANDS.includes(sub)) throw new UsageError(`unknown config subcommand "${sub}"`, CONFIG_SPEC);

  const asJson = flag(parsed.values, "json");

  if (sub === "path") {
    const paths = reportPaths();
    if (asJson) console.log(JSON.stringify(paths, null, 2));
    else for (const [key, value] of Object.entries(paths)) console.log(`${key.padEnd(12)}${value}`);
    return 0;
  }

  if (sub === "get") {
    const { config } = loadConfig({ cwd });
    const key = parsed.positionals[1];
    const value = key ? readPath(config, key) : config;
    if (key && value === undefined) {
      console.error(`No such config key: ${key}`);
      return 1;
    }
    console.log(typeof value === "string" && !asJson ? value : JSON.stringify(value, null, 2));
    return 0;
  }

  const key = parsed.positionals[1];
  const raw = parsed.positionals[2];
  if (!key || raw === undefined) throw new UsageError("config set needs a key and a value", CONFIG_SPEC);

  // JSON first so numbers, booleans and arrays keep their type; anything that
  // is not valid JSON is a plain string.
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }

  const candidate = partialHostConfigSchema.safeParse(nest(key, value));
  if (!candidate.success) {
    console.error(`Rejected: ${candidate.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return 1;
  }

  const target = writeUserConfig(candidate.data as PartialHostConfig);
  const { config } = loadConfig({ cwd });
  console.log(`${key} = ${JSON.stringify(readPath(config, key))}`);
  console.log(`Saved to ${target}`);
  return 0;
}

export function configFileLocation(): string {
  return configFilePath();
}
