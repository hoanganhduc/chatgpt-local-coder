/**
 * Argument parsing.
 *
 * A thin wrapper over `node:util`'s `parseArgs` rather than a dependency: the
 * surface needed here is one level of subcommand plus long flags, and every
 * command declares its own options so `--help` can be generated from the same
 * declaration the parser uses.
 */

import { parseArgs } from "node:util";

export type OptionType = "string" | "boolean";

export interface OptionSpec {
  type: OptionType;
  short?: string;
  multiple?: boolean;
  description: string;
  /** Shown in help as `--flag <placeholder>`. */
  placeholder?: string;
}

export interface CommandSpec {
  /** Command path as the user types it, e.g. `tunnel connect`. */
  name: string;
  summary: string;
  /** Positional part of the usage line, e.g. `<alias>`. */
  usage?: string;
  options: Record<string, OptionSpec>;
  /** Longer prose printed under the usage line. */
  detail?: string;
}

export class UsageError extends Error {
  constructor(
    message: string,
    readonly spec?: CommandSpec
  ) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedCommand {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  help: boolean;
}

const HELP_OPTION: OptionSpec = { type: "boolean", short: "h", description: "Show this help." };

export function parseCommand(argv: string[], spec: CommandSpec): ParsedCommand {
  // `parseArgs` type-checks `short` and `multiple` whenever the property is
  // present, so an explicit `undefined` is rejected the same way a number would
  // be. Each key is therefore added only when it has a value.
  const options: Record<string, { type: OptionType; short?: string; multiple?: boolean }> = {};
  for (const [name, opt] of Object.entries({ ...spec.options, help: HELP_OPTION })) {
    const entry: { type: OptionType; short?: string; multiple?: boolean } = { type: opt.type };
    if (opt.short !== undefined) entry.short = opt.short;
    if (opt.multiple !== undefined) entry.multiple = opt.multiple;
    options[name] = entry;
  }

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    return {
      values: values as ParsedCommand["values"],
      positionals,
      help: values.help === true,
    };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), spec);
  }
}

export function optionalString(values: ParsedCommand["values"], key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.length ? value : undefined;
}

export function stringList(values: ParsedCommand["values"], key: string): string[] {
  const value = values[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value.length ? [value] : [];
}

export function flag(values: ParsedCommand["values"], key: string): boolean {
  return values[key] === true;
}

/** Parse an integer flag, rejecting values that are present but not numeric. */
export function integer(values: ParsedCommand["values"], key: string): number | undefined {
  const raw = optionalString(values, key);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new UsageError(`--${key} expects an integer, got "${raw}"`);
  }
  return parsed;
}

export function renderHelp(spec: CommandSpec, binary = "chatgpt-local-coder"): string {
  const lines = [spec.summary, "", `Usage: ${binary} ${spec.name}${spec.usage ? ` ${spec.usage}` : ""} [options]`];
  if (spec.detail) lines.push("", spec.detail);

  const entries = Object.entries({ ...spec.options, help: HELP_OPTION });
  if (entries.length) {
    lines.push("", "Options:");
    const rendered = entries.map(([name, opt]) => {
      const placeholder = opt.type === "string" ? ` <${opt.placeholder ?? name}>` : "";
      const short = opt.short ? `-${opt.short}, ` : "    ";
      return [`  ${short}--${name}${placeholder}`, opt.description];
    });
    const width = Math.max(...rendered.map(([left]) => left.length));
    for (const [left, right] of rendered) lines.push(`${left.padEnd(width + 2)}${right}`);
  }

  return lines.join("\n");
}

export interface CommandGroup {
  name: string;
  summary: string;
  subcommands: string[];
}

export function renderRootHelp(groups: CommandGroup[], binary = "chatgpt-local-coder"): string {
  const lines = [
    "chatgpt-local-coder — a provider-neutral local coding host over MCP.",
    "",
    `Usage: ${binary} <command> [options]`,
    "",
    "Commands:",
  ];

  const width = Math.max(...groups.map((g) => g.name.length));
  for (const group of groups) {
    lines.push(`  ${group.name.padEnd(width + 2)}${group.summary}`);
    if (group.subcommands.length) {
      lines.push(`  ${"".padEnd(width + 2)}subcommands: ${group.subcommands.join(", ")}`);
    }
  }

  lines.push("", `Run \`${binary} <command> --help\` for the options of one command.`);
  return lines.join("\n");
}
