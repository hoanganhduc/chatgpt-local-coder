/**
 * Service installation.
 *
 * The unit is generated from a `ServiceSpec` and written to a per-user location
 * on all three platforms; nothing here needs or requests elevation. Tunnel
 * lifecycle is deliberately absent — that belongs to tunnel-client's own
 * managed runtimes, and duplicating it here would give two supervisors for one
 * process.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";

import { stateDir } from "../config/paths.js";
import { platformId, runExecutable, type PlatformId } from "../lib/platform.js";
import { launchdPlan } from "./launchd.js";
import { systemdPlan } from "./systemd.js";
import { isOwnedWindowsTask, TASK_NAME, windowsPlan, windowsTaskQueryCommand } from "./windows.js";
import type { ServicePlan, ServiceSpec, ServiceStatus } from "./types.js";

export * from "./types.js";
export { renderSystemdUnit, systemdUnitPath, systemdPlan, UNIT_NAME } from "./systemd.js";
export { renderLaunchAgent, launchdPlistPath, launchdPlan, LABEL } from "./launchd.js";
export {
  isOwnedWindowsTask,
  renderTaskXml,
  taskXmlPath,
  windowsArgumentLine,
  windowsPlan,
  windowsTaskQueryCommand,
  TASK_NAME,
  TASK_OWNERSHIP_MARKER,
} from "./windows.js";

export function defaultLogPath(): string {
  return path.join(stateDir(), "server.log");
}

const LOG_ROTATE_BYTES = parseInt(process.env.CLC_LOG_MAX_BYTES || String(8 * 1024 * 1024), 10);

/**
 * Roll the server log over if the previous runs left it large.
 *
 * Copy-and-truncate rather than rename: all three supervisors redirect stdout
 * by opening the file themselves, so by the time the server process runs, the
 * descriptor is already held. Renaming would move the inode out from under it
 * and every later line would land in the rotated file, invisible to anyone
 * reading the live one. Truncating keeps the descriptor valid — an append-mode
 * write goes to the current end, which is now zero.
 *
 * Called once at boot rather than on a timer, because a mid-run truncation
 * races the writes it is trying to bound. Set CLC_LOG_MAX_BYTES=0 to disable.
 */
export async function rotateServerLog(logPath: string = defaultLogPath()): Promise<boolean> {
  if (!Number.isFinite(LOG_ROTATE_BYTES) || LOG_ROTATE_BYTES <= 0) return false;
  try {
    const stat = await fs.stat(logPath);
    if (stat.size < LOG_ROTATE_BYTES) return false;
    await fs.copyFile(logPath, `${logPath}.1`);
    await fs.truncate(logPath, 0);
    return true;
  } catch {
    // No log yet, or a read-only location: nothing to roll over, and failing to
    // rotate is never a reason to refuse to start.
    return false;
  }
}

/**
 * Build the plan for a platform. The platform is a parameter rather than a
 * lookup so the generators can be asserted for all three from one machine.
 */
export function servicePlan(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  home: string = os.homedir()
): ServicePlan {
  switch (platform) {
    case "win32":
      return windowsPlan(spec, home);
    case "darwin":
      return launchdPlan(spec, home);
    default:
      return systemdPlan(spec, home);
  }
}

export interface InstallResult {
  plan: ServicePlan;
  unitWritten: string;
  commandResults: Array<{ command: string; exitCode: number | null; stderr: string }>;
  /** Whether recoverable unit/task metadata exists after the operation. */
  metadataPresent: boolean;
}

export interface ServiceOperationOptions {
  /** Override the per-user unit location; primarily useful for isolated tests. */
  home?: string;
  /** Execute service-manager commands; primarily useful for isolated tests. */
  runner?: typeof runExecutable;
}

type CommandResult = InstallResult["commandResults"][number];

async function runOne(
  command: string,
  args: string[],
  runner: typeof runExecutable
): Promise<{ summary: CommandResult; run: Awaited<ReturnType<typeof runExecutable>> }> {
  const run = await runner(command, args, { timeoutMs: 30_000 });
  return {
    summary: { command: [command, ...args].join(" "), exitCode: run.exitCode, stderr: run.stderr },
    run,
  };
}

async function runAll(
  commands: ServicePlan["installCommands"],
  runner: typeof runExecutable
): Promise<InstallResult["commandResults"]> {
  const results: InstallResult["commandResults"] = [];
  for (const [command, args] of commands) {
    const { summary } = await runOne(command, args, runner);
    results.push(summary);
    if (summary.exitCode !== 0) break;
  }
  return results;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function probeWindowsTask(spec: ServiceSpec, runner: typeof runExecutable): Promise<{
  exists: boolean;
  owned: boolean;
  query: CommandResult;
  blocking?: CommandResult;
}> {
  const [command, args] = windowsTaskQueryCommand();
  const { summary, run } = await runOne(command, args, runner);
  if (run.spawnFailed || run.exitCode === null || run.truncated) {
    const blocking =
      run.truncated && summary.exitCode === 0
        ? {
            ...summary,
            exitCode: 1,
            stderr: summary.stderr || "refusing to trust truncated Scheduled Task XML",
          }
        : summary;
    return { exists: false, owned: false, query: summary, blocking };
  }
  if (run.exitCode !== 0) return { exists: false, owned: false, query: summary };
  if (isOwnedWindowsTask(run.stdout, spec)) return { exists: true, owned: true, query: summary };
  return {
    exists: true,
    owned: false,
    query: summary,
    blocking: {
      command: summary.command,
      exitCode: 1,
      stderr: `refusing to modify existing unowned Scheduled Task ${JSON.stringify(TASK_NAME)}`,
    },
  };
}

export async function installService(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  options: ServiceOperationOptions = {}
): Promise<InstallResult> {
  const plan = servicePlan(spec, platform, options.home ?? os.homedir());
  const runner = options.runner ?? runExecutable;
  let installCommands = plan.installCommands;

  if (platform === "win32") {
    const probe = await probeWindowsTask(spec, runner);
    if (probe.blocking) {
      return {
        plan,
        unitWritten: plan.unitPath,
        commandResults: [probe.blocking],
        metadataPresent: await fileExists(plan.unitPath),
      };
    }
    if (probe.exists && probe.owned) {
      installCommands = plan.installCommands.map(([command, args], index): [string, string[]] =>
        index === 0 ? [command, [...args, "/F"]] : [command, [...args]]
      );
    }
  }

  await fs.mkdir(path.dirname(plan.unitPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.logPath), { recursive: true });
  let previous: Buffer | undefined;
  try {
    previous = await fs.readFile(plan.unitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The Windows task XML must be UTF-16LE with a BOM or schtasks rejects it.
  const encoding = plan.mechanism === "schtasks-logon" ? "utf16le" : "utf-8";
  const body = encoding === "utf16le" ? `﻿${plan.content}` : plan.content;
  await fs.writeFile(plan.unitPath, body, encoding);

  const commandResults = await runAll(installCommands, runner);
  if (platform === "win32" && commandResults.some((entry) => entry.exitCode !== 0)) {
    if (previous !== undefined) await fs.writeFile(plan.unitPath, previous);
    else await fs.rm(plan.unitPath, { force: true });
  }
  return { plan, unitWritten: plan.unitPath, commandResults, metadataPresent: await fileExists(plan.unitPath) };
}

export async function uninstallService(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  options: ServiceOperationOptions = {}
): Promise<InstallResult> {
  const plan = servicePlan(spec, platform, options.home ?? os.homedir());
  const runner = options.runner ?? runExecutable;

  if (platform === "win32") {
    const probe = await probeWindowsTask(spec, runner);
    if (probe.blocking || !probe.exists) {
      return {
        plan,
        unitWritten: plan.unitPath,
        commandResults: [probe.blocking ?? probe.query],
        metadataPresent: await fileExists(plan.unitPath),
      };
    }
  }

  const commandResults = await runAll(plan.uninstallCommands, runner);
  if (commandResults.every((entry) => entry.exitCode === 0)) {
    await fs.rm(plan.unitPath, { force: true });
  }
  return { plan, unitWritten: plan.unitPath, commandResults, metadataPresent: await fileExists(plan.unitPath) };
}

export async function stopService(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  options: ServiceOperationOptions = {}
): Promise<InstallResult> {
  const plan = servicePlan(spec, platform, options.home ?? os.homedir());
  const runner = options.runner ?? runExecutable;

  if (platform === "win32") {
    const probe = await probeWindowsTask(spec, runner);
    if (probe.blocking || !probe.exists) {
      return {
        plan,
        unitWritten: plan.unitPath,
        commandResults: [probe.blocking ?? probe.query],
        metadataPresent: await fileExists(plan.unitPath),
      };
    }
  }

  return {
    plan,
    unitWritten: plan.unitPath,
    commandResults: await runAll(plan.stopCommands, runner),
    metadataPresent: await fileExists(plan.unitPath),
  };
}

export async function serviceStatus(
  spec: ServiceSpec,
  platform: PlatformId = platformId()
): Promise<ServiceStatus> {
  const plan = servicePlan(spec, platform);

  let installed = false;
  try {
    await fs.access(plan.unitPath);
    installed = true;
  } catch {
    /* not installed */
  }

  const [command, args] = plan.statusCommand;
  const run = await runExecutable(command, args, { timeoutMs: 15_000 });
  const output = `${run.stdout}\n${run.stderr}`.trim();

  // Each mechanism reports liveness differently; nothing generic would be true
  // for all three.
  const running =
    plan.mechanism === "systemd-user"
      ? run.stdout.trim() === "active"
      : plan.mechanism === "launchd-agent"
        ? run.exitCode === 0 && /state\s*=\s*running/i.test(run.stdout)
        : run.exitCode === 0 && /Status:\s*Running/i.test(run.stdout);

  return { mechanism: plan.mechanism, unitPath: plan.unitPath, installed, running, detail: output };
}
