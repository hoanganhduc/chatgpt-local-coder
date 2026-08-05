/**
 * `service install|uninstall|status`.
 *
 * The generated unit runs `up --no-tunnel`: the tunnel has its own supervisor,
 * and letting a service-managed server also connect one would give two owners
 * for a single runtime.
 */

import path from "path";

import { loadConfig } from "../../config/load.js";
import { configFilePath, stateDir } from "../../config/paths.js";
import { platformId, type PlatformId } from "../../lib/platform.js";
import {
  installService,
  serviceStatus,
  servicePlan,
  uninstallService,
  type ServiceSpec,
} from "../../services/index.js";
import { flag, optionalString, parseCommand, UsageError, type CommandSpec } from "../args.js";
import { serverEntryPoint } from "./serve.js";

export const SERVICE_SUBCOMMANDS = ["install", "uninstall", "status"];

export const SERVICE_SPEC: CommandSpec = {
  name: "service",
  summary: "Install the host as a per-user background service.",
  usage: `<${SERVICE_SUBCOMMANDS.join("|")}>`,
  detail:
    "Linux uses a systemd user unit, macOS a LaunchAgent, Windows a schtasks logon task.\n" +
    "None of the three needs elevation, and none of them manages the tunnel.",
  options: {
    "dry-run": { type: "boolean", description: "Print the generated unit instead of installing it." },
    platform: {
      type: "string",
      description: "Generate for another platform (win32, darwin, linux). Implies --dry-run.",
      placeholder: "id",
    },
    json: { type: "boolean", description: "Emit JSON." },
  },
};

/** What the service runs: this Node binary, the built entry point, `up --no-tunnel`. */
export function defaultServiceSpec(cwd = process.cwd()): ServiceSpec {
  const { config } = loadConfig({ cwd });
  return {
    execPath: process.execPath,
    args: [path.resolve(path.dirname(serverEntryPoint()), "cli", "main.js"), "up", "--no-tunnel"],
    workingDirectory: config.workspaceRoots[0] ?? cwd,
    description: "chatgpt-local-coder MCP host",
    logPath: path.join(stateDir(), "server.log"),
    env: { CLC_CONFIG_DIR: path.dirname(configFilePath()), NODE_ENV: "production" },
  };
}

function parsePlatform(raw: string | undefined): PlatformId | undefined {
  if (!raw) return undefined;
  if (raw === "win32" || raw === "darwin" || raw === "linux") return raw;
  throw new UsageError(`--platform expects win32, darwin, or linux, got "${raw}"`);
}

export async function runService(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, SERVICE_SPEC);
  const sub = parsed.positionals[0];

  if (!sub) throw new UsageError(`service needs a subcommand: ${SERVICE_SUBCOMMANDS.join(", ")}`, SERVICE_SPEC);
  if (!SERVICE_SUBCOMMANDS.includes(sub)) throw new UsageError(`unknown service subcommand "${sub}"`, SERVICE_SPEC);

  const spec = defaultServiceSpec(cwd);
  const target = parsePlatform(optionalString(parsed.values, "platform"));
  const asJson = flag(parsed.values, "json");
  // Generating for another platform can only ever be a preview.
  const dryRun = flag(parsed.values, "dry-run") || (target !== undefined && target !== platformId());

  if (sub === "status") {
    const status = await serviceStatus(spec, target);
    if (asJson) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`${status.mechanism}: ${status.installed ? "installed" : "not installed"}${status.running ? ", running" : ""}`);
      console.log(`  unit: ${status.unitPath}`);
      if (status.detail) console.log(`  ${status.detail.split("\n").join("\n  ")}`);
    }
    return status.installed ? 0 : 1;
  }

  if (dryRun) {
    const plan = servicePlan(spec, target);
    if (asJson) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`# ${plan.mechanism} — would write ${plan.unitPath}`);
      console.log(plan.content);
      console.log(`# then run: ${plan.installCommands.map(([c, a]) => `${c} ${a.join(" ")}`).join("; ")}`);
      for (const note of plan.notes) console.log(`# note: ${note}`);
    }
    return 0;
  }

  const result = sub === "install" ? await installService(spec) : await uninstallService(spec);
  const failed = result.commandResults.filter((r) => r.exitCode !== 0);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${sub === "install" ? "Installed" : "Uninstalled"} ${result.plan.mechanism}: ${result.unitWritten}`);
    for (const entry of result.commandResults) {
      console.log(`  ${entry.command} -> exit ${entry.exitCode}${entry.stderr ? ` (${entry.stderr})` : ""}`);
    }
    for (const note of result.plan.notes) console.log(`  note: ${note}`);
  }

  return failed.length ? 1 : 0;
}
