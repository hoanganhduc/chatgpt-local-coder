/**
 * `service install|uninstall|status`.
 *
 * The host unit runs `up --no-tunnel`: the tunnel has its own supervisor, and
 * letting a service-managed server also connect one would give two owners for a
 * single runtime. Publishing the host is therefore a second, optional unit,
 * installed with `--with-tunnel`. That option explicitly transfers lifecycle
 * responsibility for the configured tunnel alias to the companion service.
 * Keeping them apart means restarting the host does not drop the tunnel, and a
 * tunnel retrying past a boot race does not drag the host through restarts.
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
  type InstallResult,
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
    "None of the three needs elevation. By default only the host is installed; add\n" +
    "--with-tunnel to let a companion unit own the configured alias lifecycle.",
  options: {
    "with-tunnel": {
      type: "boolean",
      description: "Also manage the companion unit and transfer the configured alias lifecycle to it.",
    },
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
    env: { CLC_CONFIG_DIR: path.dirname(configFilePath()), NODE_ENV: "production", CLC_SERVICE_MODE: "1" },
  };
}

/**
 * The companion unit: the same entry point, `tunnel connect --wait-for-server`.
 *
 * The wait is not optional at boot. Every supervisor treats the host unit as
 * started once its process exists, which is well before the server has bound
 * its port, and a runtime that connects into that gap reports itself healthy
 * while recording separately that it never reached the host. `--wait-for-server`
 * closes that window in one place instead of three per-platform pre-start hooks.
 *
 * Installing this spec claims lifecycle responsibility for the configured
 * alias, and both commands pin that alias rather than resolving mutable config
 * later. `stopArgs` exists because tunnel-client daemonizes the runtime out of
 * the unit's process tree: stopping the unit cannot reach it, only `tunnel
 * stop` can.
 */
export function tunnelServiceSpec(cwd = process.cwd()): ServiceSpec {
  const host = defaultServiceSpec(cwd);
  const { config } = loadConfig({ cwd });
  const entryPoint = host.args[0];
  const alias = config.tunnel.alias;
  return {
    ...host,
    role: "tunnel",
    args: [entryPoint, "tunnel", "connect", "--alias", alias, "--wait-for-server"],
    stopArgs: [entryPoint, "tunnel", "stop", "--alias", alias],
    description: "chatgpt-local-coder tunnel runtime",
    logPath: path.join(stateDir(), "tunnel.log"),
  };
}

/**
 * Install order is host then tunnel; uninstall is the reverse, so the unit that
 * depends on the host goes away before the host does.
 */
function specsFor(sub: string, cwd: string, withTunnel: boolean): ServiceSpec[] {
  const specs = withTunnel ? [defaultServiceSpec(cwd), tunnelServiceSpec(cwd)] : [defaultServiceSpec(cwd)];
  return sub === "uninstall" ? specs.reverse() : specs;
}

function parsePlatform(raw: string | undefined): PlatformId | undefined {
  if (!raw) return undefined;
  if (raw === "win32" || raw === "darwin" || raw === "linux") return raw;
  throw new UsageError(`--platform expects win32, darwin, or linux, got "${raw}"`);
}

export function formatServiceOutcome(
  sub: "install" | "uninstall",
  result: InstallResult,
  failed: boolean
): string {
  const action = sub === "install" ? "Install" : "Uninstall";
  if (!failed) return `${action}ed ${result.plan.mechanism}: ${result.unitWritten}`;
  const metadata = result.metadataPresent ? "metadata remains at" : "no metadata remains at";
  return `${action} failed for ${result.plan.mechanism}; ${metadata} ${result.unitWritten}`;
}

/** Install is dependency-ordered; uninstall is best-effort so partial states can be cleaned up. */
export function shouldContinueServiceBatch(sub: string, result: InstallResult): boolean {
  return sub === "uninstall" || !result.commandResults.some((entry) => entry.exitCode !== 0);
}

export async function runService(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, SERVICE_SPEC);
  const sub = parsed.positionals[0];

  if (!sub) throw new UsageError(`service needs a subcommand: ${SERVICE_SUBCOMMANDS.join(", ")}`, SERVICE_SPEC);
  if (!SERVICE_SUBCOMMANDS.includes(sub)) throw new UsageError(`unknown service subcommand "${sub}"`, SERVICE_SPEC);

  const withTunnel = flag(parsed.values, "with-tunnel");
  const specs = specsFor(sub, cwd, withTunnel);
  const target = parsePlatform(optionalString(parsed.values, "platform"));
  const asJson = flag(parsed.values, "json");
  // Generating for another platform can only ever be a preview.
  const dryRun = flag(parsed.values, "dry-run") || (target !== undefined && target !== platformId());

  // A single spec keeps its old single-object JSON shape; only --with-tunnel
  // turns the output into an array, so existing callers parse what they did.
  const emit = (values: unknown[]) => console.log(JSON.stringify(withTunnel ? values : values[0], null, 2));
  const label = (spec: ServiceSpec) => (withTunnel ? `${spec.role ?? "host"}: ` : "");

  if (sub === "status") {
    const statuses = [];
    for (const spec of specs) statuses.push({ role: spec.role ?? "host", ...(await serviceStatus(spec, target)) });

    if (asJson) {
      emit(statuses);
    } else {
      for (const status of statuses) {
        const state = `${status.installed ? "installed" : "not installed"}${status.running ? ", running" : ""}`;
        console.log(`${withTunnel ? `${status.role}: ` : ""}${status.mechanism}: ${state}`);
        console.log(`  unit: ${status.unitPath}`);
        if (status.detail) console.log(`  ${status.detail.split("\n").join("\n  ")}`);
      }
    }
    return statuses.every((status) => status.installed) ? 0 : 1;
  }

  if (dryRun) {
    const plans = specs.map((spec) => servicePlan(spec, target));
    if (asJson) {
      emit(plans);
    } else {
      for (const [index, plan] of plans.entries()) {
        if (index > 0) console.log("");
        console.log(`# ${label(specs[index])}${plan.mechanism} — would write ${plan.unitPath}`);
        console.log(plan.content);
        if (plan.mechanism === "schtasks-logon") {
          console.log("# install compiles and publishes the native GUI launcher before registering this template");
        } else {
          console.log(`# then run: ${plan.installCommands.map(([c, a]) => `${c} ${a.join(" ")}`).join("; ")}`);
        }
        for (const note of plan.notes) console.log(`# note: ${note}`);
      }
    }
    return 0;
  }

  const results: InstallResult[] = [];
  for (const spec of specs) {
    const result = sub === "install" ? await installService(spec) : await uninstallService(spec);
    results.push(result);
    if (!shouldContinueServiceBatch(sub, result)) break;
  }
  const failed = results.flatMap((result) => result.commandResults).filter((r) => r.exitCode !== 0);

  if (asJson) {
    emit(results);
  } else {
    for (const [index, result] of results.entries()) {
      const resultFailed = result.commandResults.some((entry) => entry.exitCode !== 0);
      console.log(`${label(specs[index])}${formatServiceOutcome(sub as "install" | "uninstall", result, resultFailed)}`);
      for (const entry of result.commandResults) {
        console.log(`  ${entry.command} -> exit ${entry.exitCode}${entry.stderr ? ` (${entry.stderr})` : ""}`);
      }
      for (const note of result.plan.notes) console.log(`  note: ${note}`);
    }
  }

  return failed.length ? 1 : 0;
}
