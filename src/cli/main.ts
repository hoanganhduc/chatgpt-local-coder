#!/usr/bin/env node
/**
 * The `chatgpt-local-coder` entry point.
 *
 * One dispatcher over a table of commands, each of which owns its own
 * `CommandSpec`. `--help` is answered here rather than inside every command so
 * that help never depends on a command's own argument validation succeeding.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { flag, parseCommand, renderHelp, renderRootHelp, UsageError, type CommandGroup, type CommandSpec } from "./args.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { INIT_SPEC, runInit } from "./commands/init.js";
import {
  CONFIG_SPEC,
  CONFIG_SUBCOMMANDS,
  runConfigCommand,
  runSettings,
  runSkills,
  SETTINGS_SPEC,
  SETTINGS_SUBCOMMANDS,
  SKILLS_SPEC,
  SKILLS_SUBCOMMANDS,
} from "./commands/misc.js";
import { runSecrets, SECRETS_SPEC, SECRETS_SUBCOMMANDS } from "./commands/secrets.js";
import { DOWN_SPEC, runDown, runStatus, runUp, STATUS_SPEC, UP_SPEC } from "./commands/serve.js";
import { runService, SERVICE_SPEC, SERVICE_SUBCOMMANDS } from "./commands/service.js";
import { runTunnel, TUNNEL_SPEC, TUNNEL_SUBCOMMANDS } from "./commands/tunnel.js";

export const BINARY = "chatgpt-local-coder";

export const DOCTOR_SPEC: CommandSpec = {
  name: "doctor",
  summary: "Check the environment and report what would stop the host from working.",
  detail: "Secrets are reported as set or unset. No secret value is ever printed.",
  options: { json: { type: "boolean", description: "Emit the report as JSON." } },
};

async function runDoctorCommand(argv: string[], cwd: string): Promise<number> {
  const parsed = parseCommand(argv, DOCTOR_SPEC);
  const report = await runDoctor(cwd);
  console.log(flag(parsed.values, "json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

interface Command {
  spec: CommandSpec;
  run: (argv: string[], cwd: string) => Promise<number>;
  subcommands?: string[];
}

export const COMMANDS: Record<string, Command> = {
  init: { spec: INIT_SPEC, run: runInit },
  doctor: { spec: DOCTOR_SPEC, run: runDoctorCommand },
  up: { spec: UP_SPEC, run: runUp },
  down: { spec: DOWN_SPEC, run: runDown },
  status: { spec: STATUS_SPEC, run: runStatus },
  secrets: { spec: SECRETS_SPEC, run: runSecrets, subcommands: SECRETS_SUBCOMMANDS },
  tunnel: { spec: TUNNEL_SPEC, run: runTunnel, subcommands: TUNNEL_SUBCOMMANDS },
  service: { spec: SERVICE_SPEC, run: runService, subcommands: SERVICE_SUBCOMMANDS },
  skills: { spec: SKILLS_SPEC, run: runSkills, subcommands: SKILLS_SUBCOMMANDS },
  settings: { spec: SETTINGS_SPEC, run: runSettings, subcommands: SETTINGS_SUBCOMMANDS },
  config: { spec: CONFIG_SPEC, run: runConfigCommand, subcommands: CONFIG_SUBCOMMANDS },
};

function groups(): CommandGroup[] {
  return Object.entries(COMMANDS).map(([name, command]) => ({
    name,
    summary: command.spec.summary,
    subcommands: command.subcommands ?? [],
  }));
}

/**
 * Help asked for by this CLI, not by whatever `skills run` is about to launch:
 * anything after a bare `--` belongs to the child.
 */
function wantsHelp(argv: string[]): boolean {
  const end = argv.indexOf("--");
  const own = end === -1 ? argv : argv.slice(0, end);
  return own.includes("--help") || own.includes("-h");
}

export function version(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(fs.readFileSync(pkg, "utf-8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[] = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = name === "help" ? rest[0] : undefined;
    if (target && COMMANDS[target]) {
      console.log(renderHelp(COMMANDS[target].spec, BINARY));
      return 0;
    }
    if (target) {
      console.error(`Unknown command: ${target}`);
      console.error("");
      console.error(renderRootHelp(groups(), BINARY));
      return 2;
    }
    console.log(renderRootHelp(groups(), BINARY));
    return 0;
  }

  if (name === "--version" || name === "-v" || name === "version") {
    console.log(version());
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command: ${name}`);
    console.error("");
    console.error(renderRootHelp(groups(), BINARY));
    return 2;
  }

  if (wantsHelp(rest)) {
    console.log(renderHelp(command.spec, BINARY));
    return 0;
  }

  try {
    return await command.run(rest, cwd);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${BINARY} ${name}: ${error.message}`);
      console.error("");
      console.error(renderHelp(error.spec ?? command.spec, BINARY));
      return 2;
    }
    console.error(`${BINARY} ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Only when executed, so tests can import `main` and call it directly.
//
// The comparison has to go through `realpathSync`. A global npm install puts a
// symlink in the bin directory that points at this file, so `process.argv[1]`
// is the link and `path.resolve` — which normalises but never follows a link —
// would never match. That made the installed CLI exit 0 and print nothing on
// Linux and macOS, where npm links; Windows was unaffected because its shim
// invokes node with the real path.
function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argv1) === path.resolve(modulePath);
  }
}

const invokedDirectly = isInvokedDirectly();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
