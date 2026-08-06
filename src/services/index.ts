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
import { windowsPlan } from "./windows.js";
import type { ServicePlan, ServiceSpec, ServiceStatus } from "./types.js";

export * from "./types.js";
export { renderSystemdUnit, systemdUnitPath, systemdPlan, UNIT_NAME } from "./systemd.js";
export { renderLaunchAgent, launchdPlistPath, launchdPlan, LABEL } from "./launchd.js";
export { renderTaskXml, taskXmlPath, windowsPlan, TASK_NAME } from "./windows.js";

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
}

async function runAll(commands: ServicePlan["installCommands"]): Promise<InstallResult["commandResults"]> {
  const results: InstallResult["commandResults"] = [];
  for (const [command, args] of commands) {
    const run = await runExecutable(command, args, { timeoutMs: 30_000 });
    results.push({ command: [command, ...args].join(" "), exitCode: run.exitCode, stderr: run.stderr });
  }
  return results;
}

export async function installService(spec: ServiceSpec, platform: PlatformId = platformId()): Promise<InstallResult> {
  const plan = servicePlan(spec, platform);

  await fs.mkdir(path.dirname(plan.unitPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.logPath), { recursive: true });
  // The Windows task XML must be UTF-16LE with a BOM or schtasks rejects it.
  const encoding = plan.mechanism === "schtasks-logon" ? "utf16le" : "utf-8";
  const body = encoding === "utf16le" ? `﻿${plan.content}` : plan.content;
  await fs.writeFile(plan.unitPath, body, encoding);

  return { plan, unitWritten: plan.unitPath, commandResults: await runAll(plan.installCommands) };
}

export async function uninstallService(
  spec: ServiceSpec,
  platform: PlatformId = platformId()
): Promise<InstallResult> {
  const plan = servicePlan(spec, platform);
  const commandResults = await runAll(plan.uninstallCommands);
  await fs.rm(plan.unitPath, { force: true });
  return { plan, unitWritten: plan.unitPath, commandResults };
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
