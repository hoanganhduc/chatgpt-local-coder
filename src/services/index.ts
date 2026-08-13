/**
 * Service installation.
 *
 * The unit is generated from a `ServiceSpec` and written to a per-user location
 * on all three platforms; nothing here needs or requests elevation.
 *
 * A spec carries a `role`, and the two roles produce two separate units. The
 * host unit runs the server. The tunnel unit runs `tunnel connect`, which hands
 * the runtime to tunnel-client's own supervisor and returns — so the tunnel
 * unit takes lifecycle responsibility for a runtime it does not supervise.
 * That is why the tunnel spec also carries `stopArgs`: the runtime lives
 * outside the unit, and only `tunnel stop` can reach it. Installing that unit
 * explicitly transfers responsibility for the configured alias to the service.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { stateDir } from "../config/paths.js";
import { platformId, runExecutable, type PlatformId } from "../lib/platform.js";
import { launchdPlan } from "./launchd.js";
import { systemdPlan } from "./systemd.js";
import {
  isOwnedWindowsTask,
  TASK_NAME,
  windowsLauncherCompileCommand,
  windowsLauncherExecutablePath,
  windowsLauncherSourcePath,
  windowsLauncherSupportDirectory,
  windowsPlan,
  windowsTaskLauncherExecutablePath,
  windowsTaskName,
  windowsTaskQueryCommand,
} from "./windows.js";
import { WINDOWS_LAUNCHER_SOURCE } from "./windows-launcher.js";
import type { ServiceCommand, ServicePlan, ServiceSpec, ServiceStatus } from "./types.js";

export * from "./types.js";
export {
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
  systemdPlan,
  UNIT_NAME,
  TUNNEL_UNIT_NAME,
} from "./systemd.js";
export {
  renderLaunchAgent,
  launchdLabel,
  launchdPlistPath,
  launchdPlan,
  LABEL,
  TUNNEL_LABEL,
} from "./launchd.js";
export {
  isOwnedWindowsTask,
  renderWindowsPowerShellPredecessorTaskXml,
  renderTaskXml,
  taskXmlPath,
  windowsLauncherCompileCommand,
  windowsLauncherExecutablePath,
  windowsLauncherSourcePath,
  windowsLauncherSupportDirectory,
  windowsArgumentLine,
  windowsPlan,
  windowsTaskLauncherExecutablePath,
  windowsTaskName,
  windowsTaskQueryCommand,
  TASK_NAME,
  TASK_OWNERSHIP_MARKER,
  TUNNEL_TASK_NAME,
} from "./windows.js";
export {
  WINDOWS_LAUNCHER_BASENAME,
  WINDOWS_LAUNCHER_SOURCE,
  WINDOWS_LAUNCHER_SOURCE_SHA256,
} from "./windows-launcher.js";

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
  runner: typeof runExecutable,
  continueAfterFailure = false
): Promise<InstallResult["commandResults"]> {
  const results: InstallResult["commandResults"] = [];
  for (const [command, args] of commands) {
    const { summary } = await runOne(command, args, runner);
    results.push(summary);
    if (summary.exitCode !== 0 && !continueAfterFailure) break;
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

function uninstallMarkerPath(plan: ServicePlan): string {
  return `${plan.unitPath}.uninstalling`;
}

function ownershipMetadataPath(plan: ServicePlan): string {
  return `${plan.unitPath}.owner.json`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isStoredServiceSpec(value: unknown): value is ServiceSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ServiceSpec>;
  return (
    typeof candidate.execPath === "string" &&
    Array.isArray(candidate.args) &&
    candidate.args.every((entry) => typeof entry === "string") &&
    typeof candidate.workingDirectory === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.logPath === "string" &&
    isStringRecord(candidate.env) &&
    (candidate.role === "host" || candidate.role === "tunnel" || candidate.role === undefined) &&
    Array.isArray(candidate.stopArgs) &&
    candidate.stopArgs.every((entry) => typeof entry === "string")
  );
}

async function loadOwnedServiceSpec(plan: ServicePlan, requested: ServiceSpec): Promise<ServiceSpec> {
  let raw: string;
  try {
    raw = await fs.readFile(ownershipMetadataPath(plan), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return requested;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`refusing service cleanup with invalid ownership metadata at ${ownershipMetadataPath(plan)}`);
  }
  const record = parsed as { version?: unknown; spec?: unknown };
  if (record.version !== 1 || !isStoredServiceSpec(record.spec)) {
    throw new Error(`refusing service cleanup with invalid ownership metadata at ${ownershipMetadataPath(plan)}`);
  }
  if (
    (record.spec.role ?? "host") !== (requested.role ?? "host") ||
    record.spec.execPath !== requested.execPath ||
    record.spec.args[0] !== requested.args[0] ||
    record.spec.stopArgs?.[0] !== requested.stopArgs?.[0]
  ) {
    throw new Error(`refusing service cleanup with mismatched ownership metadata at ${ownershipMetadataPath(plan)}`);
  }
  return record.spec;
}

async function metadataPresent(plan: ServicePlan): Promise<boolean> {
  return (
    (await fileExists(plan.unitPath)) ||
    (await fileExists(ownershipMetadataPath(plan))) ||
    (await fileExists(uninstallMarkerPath(plan)))
  );
}

async function probeWindowsTask(spec: ServiceSpec, runner: typeof runExecutable, home: string): Promise<{
  exists: boolean;
  owned: boolean;
  query: CommandResult;
  blocking?: CommandResult;
  taskXml?: string;
  launcherPath?: string;
}> {
  const role = spec.role ?? "host";
  const task = windowsTaskName(role);
  const [command, args] = windowsTaskQueryCommand(role);
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
  const launcherPath = windowsTaskLauncherExecutablePath(run.stdout, spec, home);
  if (launcherPath) {
    try {
      await assertSafeSupportParents(launcherPath);
      await validatePublishedGuiExecutable(launcherPath);
      return { exists: true, owned: true, query: summary, taskXml: run.stdout, launcherPath };
    } catch (error) {
      return {
        exists: true,
        owned: false,
        query: summary,
        taskXml: run.stdout,
        blocking: operationFailure(summary.command, error),
      };
    }
  }
  if (isOwnedWindowsTask(run.stdout, spec, home)) {
    return { exists: true, owned: true, query: summary, taskXml: run.stdout };
  }
  return {
    exists: true,
    owned: false,
    query: summary,
    blocking: {
      command: summary.command,
      exitCode: 1,
      stderr: `refusing to modify existing unowned Scheduled Task ${JSON.stringify(task)}`,
    },
  };
}

interface FileSnapshot {
  path: string;
  previous?: Buffer;
}

async function snapshotFile(file: string): Promise<FileSnapshot> {
  try {
    return { path: file, previous: await fs.readFile(file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file };
    throw error;
  }
}

async function restoreFiles(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.previous === undefined) {
      await fs.rm(snapshot.path, { force: true });
    } else {
      await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
      await fs.writeFile(snapshot.path, snapshot.previous);
    }
  }
}

async function assertSafeSupportParents(file: string): Promise<void> {
  const parent = path.resolve(path.dirname(file));
  const root = path.parse(parent).root;
  const components = path.relative(root, parent).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of ["", ...components]) {
    if (component) current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing launcher support path with reparse-point parent ${JSON.stringify(current)}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`refusing launcher support path with non-directory parent ${JSON.stringify(current)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function writeContentAddressedSource(file: string, content: string): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing unsafe launcher source ${JSON.stringify(file)}`);
    if ((await fs.readFile(file, "utf8")) !== content) {
      throw new Error(`content-addressed launcher source mismatch at ${JSON.stringify(file)}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(file, "utf8")) !== content) {
        throw new Error(`content-addressed launcher source collision at ${JSON.stringify(file)}`);
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readValidatedGuiExecutable(file: string): Promise<Buffer | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing unsafe native launcher ${JSON.stringify(file)}`);
    const bytes = await fs.readFile(file);
    if (bytes.length < 128 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("native launcher is not a PE image");
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 96 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
      throw new Error("native launcher has an invalid PE header");
    }
    const optionalHeader = peOffset + 24;
    const magic = bytes.readUInt16LE(optionalHeader);
    if ((magic !== 0x10b && magic !== 0x20b) || bytes.readUInt16LE(optionalHeader + 68) !== 2) {
      throw new Error("native launcher is not a Windows GUI executable");
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function validatePublishedGuiExecutable(file: string): Promise<Buffer> {
  const expectedDigest = /^ChatGPTLocalCoderLauncher-([a-f0-9]{64})\.exe$/i.exec(path.basename(file))?.[1]?.toLowerCase();
  if (!expectedDigest) throw new Error(`native launcher path is not content-addressed: ${JSON.stringify(file)}`);
  const bytes = await readValidatedGuiExecutable(file);
  if (!bytes) throw new Error(`native launcher is missing: ${JSON.stringify(file)}`);
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(`native launcher digest mismatch at ${JSON.stringify(file)}`);
  }
  return bytes;
}

async function publishWindowsLauncher(
  temporaryPath: string,
  home: string
): Promise<{ executablePath: string; created: boolean }> {
  const freshBytes = await readValidatedGuiExecutable(temporaryPath);
  if (!freshBytes) throw new Error("native launcher compiler reported success without an output file");
  const digest = createHash("sha256").update(freshBytes).digest("hex");
  const executablePath = windowsLauncherExecutablePath(home, digest);
  await assertSafeSupportParents(executablePath);
  try {
    await fs.link(temporaryPath, executablePath);
    return { executablePath, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingBytes = await validatePublishedGuiExecutable(executablePath);
    if (!existingBytes.equals(freshBytes)) {
      throw new Error(`native launcher SHA-256 collision at ${JSON.stringify(executablePath)}`);
    }
    return { executablePath, created: false };
  }
}

function operationFailure(command: string, error: unknown): CommandResult {
  return {
    command,
    exitCode: 1,
    stderr: error instanceof Error ? error.message : String(error),
  };
}

async function installWindowsService(
  spec: ServiceSpec,
  plan: ServicePlan,
  home: string,
  runner: typeof runExecutable
): Promise<InstallResult> {
  const initial = await probeWindowsTask(spec, runner, home);
  if (initial.blocking) {
    return {
      plan,
      unitWritten: plan.unitPath,
      commandResults: [initial.blocking],
      metadataPresent: await fileExists(plan.unitPath),
    };
  }

  const sourcePath = windowsLauncherSourcePath(home);
  const supportDirectory = windowsLauncherSupportDirectory(home);
  const temporaryExecutablePath = path.join(
    supportDirectory,
    `.ChatGPTLocalCoderLauncher-${randomUUID()}.tmp.exe`
  );
  const commandResults: CommandResult[] = [];
  try {
    await assertSafeSupportParents(sourcePath);
    await assertSafeSupportParents(temporaryExecutablePath);
  } catch (error) {
    commandResults.push(operationFailure("prepare native Windows launcher", error));
    return { plan, unitWritten: plan.unitPath, commandResults, metadataPresent: await fileExists(plan.unitPath) };
  }
  const unitSnapshot = await snapshotFile(plan.unitPath);
  const sourceExisted = await fileExists(sourcePath);
  let installedPlan = plan;
  let publishedExecutablePath: string | undefined;
  let publishedExecutableCreated = false;
  const rollback = async (): Promise<void> => {
    await restoreFiles([unitSnapshot]);
    await assertSafeSupportParents(sourcePath);
    await assertSafeSupportParents(temporaryExecutablePath);
    if (!sourceExisted) await fs.rm(sourcePath, { force: true });
    await fs.rm(temporaryExecutablePath, { force: true });
    if (publishedExecutableCreated && publishedExecutablePath) {
      await assertSafeSupportParents(publishedExecutablePath);
      await fs.rm(publishedExecutablePath, { force: true });
    }
  };
  try {
    await fs.mkdir(path.dirname(plan.unitPath), { recursive: true });
    await fs.mkdir(path.dirname(spec.logPath), { recursive: true });
    await fs.mkdir(supportDirectory, { recursive: true });
    await assertSafeSupportParents(sourcePath);
    await assertSafeSupportParents(temporaryExecutablePath);
    await writeContentAddressedSource(sourcePath, WINDOWS_LAUNCHER_SOURCE);

    await assertSafeSupportParents(sourcePath);
    await assertSafeSupportParents(temporaryExecutablePath);
    const [compileCommand, compileArgs] = windowsLauncherCompileCommand(sourcePath, temporaryExecutablePath);
    const compiled = await runOne(compileCommand, compileArgs, runner);
    commandResults.push(compiled.summary);
    if (compiled.summary.exitCode !== 0) {
      await rollback();
      return { plan, unitWritten: plan.unitPath, commandResults, metadataPresent: await fileExists(plan.unitPath) };
    }

    const published = await publishWindowsLauncher(temporaryExecutablePath, home);
    publishedExecutablePath = published.executablePath;
    publishedExecutableCreated = published.created;
    await fs.rm(temporaryExecutablePath, { force: true });
    installedPlan = windowsPlan(spec, home, process.env, publishedExecutablePath);
    await fs.writeFile(installedPlan.unitPath, `﻿${installedPlan.content}`, "utf16le");

    // Re-query after staging/compilation and immediately before the only task
    // mutation. A same-name task appearing, disappearing, or changing ownership
    // during preparation makes the install fail closed.
    const current = await probeWindowsTask(spec, runner, home);
    if (
      current.blocking ||
      current.exists !== initial.exists ||
      current.owned !== initial.owned ||
      current.taskXml !== initial.taskXml
    ) {
      commandResults.push(
        current.blocking ?? operationFailure(current.query.command, new Error("Scheduled Task changed during install preparation"))
      );
      await rollback();
      return {
        plan: installedPlan,
        unitWritten: installedPlan.unitPath,
        commandResults,
        metadataPresent: await fileExists(installedPlan.unitPath),
      };
    }

    const [createCommand, createArgs] = installedPlan.installCommands[0];
    const create = await runOne(
      createCommand,
      current.exists && current.owned ? [...createArgs, "/F"] : createArgs,
      runner
    );
    const afterCreate = await probeWindowsTask(spec, runner, home);
    const intendedInstalled =
      afterCreate.exists &&
      afterCreate.owned &&
      afterCreate.launcherPath?.toLowerCase() === publishedExecutablePath.toLowerCase();
    if (intendedInstalled) {
      commandResults.push(
        create.summary.exitCode === 0
          ? create.summary
          : {
              ...create.summary,
              exitCode: 0,
              stderr: [create.summary.stderr, "task creation was confirmed by a post-create ownership query"]
                .filter(Boolean)
                .join("; "),
            }
      );
    } else {
      const initialTaskConfirmedUnchanged =
        initial.exists &&
        afterCreate.exists &&
        !afterCreate.blocking &&
        afterCreate.owned === initial.owned &&
        afterCreate.taskXml === initial.taskXml;
      if (initialTaskConfirmedUnchanged) await rollback();
      commandResults.push(
        create.summary.exitCode !== 0
          ? create.summary
          : operationFailure(
              create.summary.command,
              new Error("task creation returned success but the intended Scheduled Task could not be verified")
            )
      );
    }
    return {
      plan: installedPlan,
      unitWritten: installedPlan.unitPath,
      commandResults,
      metadataPresent: await fileExists(installedPlan.unitPath),
    };
  } catch (error) {
    commandResults.push(operationFailure("prepare native Windows launcher", error));
    await rollback();
    return {
      plan: installedPlan,
      unitWritten: installedPlan.unitPath,
      commandResults,
      metadataPresent: await fileExists(installedPlan.unitPath),
    };
  }
}

export async function installService(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  options: ServiceOperationOptions = {}
): Promise<InstallResult> {
  const home = options.home ?? os.homedir();
  const plan = servicePlan(spec, platform, home);
  const runner = options.runner ?? runExecutable;
  let installCommands = plan.installCommands;

  if (spec.stopArgs) {
    if (await fileExists(uninstallMarkerPath(plan))) {
      throw new Error(
        `refusing to install while tunnel cleanup is pending at ${uninstallMarkerPath(plan)}; run service uninstall first`
      );
    }
    const installedSpec = await loadOwnedServiceSpec(plan, spec);
    if (
      JSON.stringify(installedSpec.args) !== JSON.stringify(spec.args) ||
      JSON.stringify(installedSpec.stopArgs) !== JSON.stringify(spec.stopArgs)
    ) {
      throw new Error(
        `refusing to change the service-owned tunnel lifecycle in place; uninstall the existing companion first`
      );
    }
  }

  // Windows stages, publishes and rolls back its own files — including the true
  // previous task XML, which it snapshots itself. Nothing may be written here
  // before it runs, or that snapshot captures the new content and a failed
  // install "restores" what it was supposed to undo. Ownership metadata is this
  // layer's concern, and is recorded only once the task actually committed.
  if (platform === "win32") {
    const result = await installWindowsService(spec, plan, home, runner);
    if (result.commandResults.every((entry) => entry.exitCode === 0)) {
      if (spec.stopArgs) {
        await fs.writeFile(
          ownershipMetadataPath(result.plan),
          `${JSON.stringify({ version: 1, spec }, null, 2)}\n`,
          { encoding: "utf-8", mode: 0o600 }
        );
      } else {
        await fs.rm(ownershipMetadataPath(result.plan), { force: true });
      }
    }
    return { ...result, metadataPresent: await metadataPresent(result.plan) };
  }

  await fs.mkdir(path.dirname(plan.unitPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.logPath), { recursive: true });
  let previous: Buffer | undefined;
  let previousOwnership: Buffer | undefined;
  try {
    previous = await fs.readFile(plan.unitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    previousOwnership = await fs.readFile(ownershipMetadataPath(plan));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The Windows task XML must be UTF-16LE with a BOM or schtasks rejects it.
  const encoding = plan.mechanism === "schtasks-logon" ? "utf16le" : "utf-8";
  const body = encoding === "utf16le" ? `﻿${plan.content}` : plan.content;
  await fs.writeFile(plan.unitPath, body, encoding);
  if (spec.stopArgs) {
    try {
      await fs.writeFile(
        ownershipMetadataPath(plan),
        `${JSON.stringify({ version: 1, spec }, null, 2)}\n`,
        { encoding: "utf-8", mode: 0o600 }
      );
    } catch (error) {
      if (previous !== undefined) await fs.writeFile(plan.unitPath, previous);
      else await fs.rm(plan.unitPath, { force: true });
      if (previousOwnership !== undefined) await fs.writeFile(ownershipMetadataPath(plan), previousOwnership);
      else await fs.rm(ownershipMetadataPath(plan), { force: true });
      throw error;
    }
  } else {
    await fs.rm(ownershipMetadataPath(plan), { force: true });
  }

  const commandResults = await runAll(installCommands, runner);
  return { plan, unitWritten: plan.unitPath, commandResults, metadataPresent: await metadataPresent(plan) };
}

export async function uninstallService(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  options: ServiceOperationOptions = {}
): Promise<InstallResult> {
  const home = options.home ?? os.homedir();
  const requestedPlan = servicePlan(spec, platform, home);
  const ownedSpec = spec.stopArgs ? await loadOwnedServiceSpec(requestedPlan, spec) : spec;
  const plan = servicePlan(ownedSpec, platform, home);
  const runner = options.runner ?? runExecutable;
  const externalCleanup = Boolean(ownedSpec.stopArgs);
  const markerPath = uninstallMarkerPath(plan);
  const cleanupPending = externalCleanup && (await fileExists(markerPath));

  if (platform === "win32") {
    const probe = await probeWindowsTask(ownedSpec, runner, home);
    if (probe.blocking) {
      return {
        plan,
        unitWritten: plan.unitPath,
        commandResults: [probe.blocking],
        metadataPresent: await metadataPresent(plan),
      };
    }
    if (!probe.exists) {
      const hasMetadata = await metadataPresent(plan);
      if (cleanupPending && ownedSpec.stopArgs) {
        // The marker was written only after an owned wrapper was successfully
        // deleted. Its failed query is therefore the expected retry state, not
        // an ownership ambiguity. Finish the external cleanup and converge.
        const commandResults = await runAll([[ownedSpec.execPath, ownedSpec.stopArgs]], runner);
        if (commandResults.every((entry) => entry.exitCode === 0)) {
          await fs.rm(plan.unitPath, { force: true });
          await fs.rm(markerPath, { force: true });
          await fs.rm(ownershipMetadataPath(plan), { force: true });
        }
        return {
          plan,
          unitWritten: plan.unitPath,
          commandResults,
          metadataPresent: await metadataPresent(plan),
        };
      }
      // A non-zero query may mean absent, denied, or another manager error. The
      // durable uninstall marker is the only proof that our owned wrapper was
      // already removed, so metadata alone never authorizes an alias stop.
      return { plan, unitWritten: plan.unitPath, commandResults: [probe.query], metadataPresent: hasMetadata };
    }
  }

  if (cleanupPending && ownedSpec.stopArgs) {
    const commandResults = await runAll([[ownedSpec.execPath, ownedSpec.stopArgs]], runner);
    if (commandResults.every((entry) => entry.exitCode === 0)) {
      await fs.rm(plan.unitPath, { force: true });
      await fs.rm(markerPath, { force: true });
      await fs.rm(ownershipMetadataPath(plan), { force: true });
    }
    return {
      plan,
      unitWritten: plan.unitPath,
      commandResults,
      metadataPresent: await metadataPresent(plan),
    };
  }

  const commands: ServiceCommand[] = [...plan.uninstallCommands];

  // The external stop is a cleanup step, not a dependent mutation. Run it even
  // when unloading/deleting the wrapper fails so a retry cannot strand a live
  // daemonized tunnel after its wrapper has already disappeared. This remains
  // necessary on systemd because ExecStop is not guaranteed after a failed
  // oneshot ExecStart.
  const wrapperResults = externalCleanup ? await runAll(plan.uninstallCommands, runner) : undefined;
  const commandResults = wrapperResults ?? (await runAll(commands, runner));
  if (wrapperResults) {
    const wrapperRemoved = wrapperResults.every((entry) => entry.exitCode === 0);
    if (wrapperRemoved) {
      try {
        await fs.writeFile(markerPath, "owned service wrapper removed; external cleanup pending\n", {
          encoding: "utf-8",
          mode: 0o600,
        });
      } catch (error) {
        commandResults.push({
          command: `write ${markerPath}`,
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (ownedSpec.stopArgs) {
      commandResults.push(...(await runAll([[ownedSpec.execPath, ownedSpec.stopArgs]], runner)));
    }
  }
  if (commandResults.every((entry) => entry.exitCode === 0)) {
    // schtasks reports absence, access denial, and RPC failures through the
    // same localized non-zero channel. Remove only the retry XML here and
    // retain inert, content-addressed launcher support rather than risk
    // deleting a binary that Task Scheduler may still reference.
    await fs.rm(plan.unitPath, { force: true });
    await fs.rm(markerPath, { force: true });
    await fs.rm(ownershipMetadataPath(plan), { force: true });
  }
  return {
    plan,
    unitWritten: plan.unitPath,
    commandResults,
    metadataPresent: await metadataPresent(plan),
  };
}

export async function stopService(
  spec: ServiceSpec,
  platform: PlatformId = platformId(),
  options: ServiceOperationOptions = {}
): Promise<InstallResult> {
  const home = options.home ?? os.homedir();
  const requestedPlan = servicePlan(spec, platform, home);
  const ownedSpec = spec.stopArgs ? await loadOwnedServiceSpec(requestedPlan, spec) : spec;
  const plan = servicePlan(ownedSpec, platform, home);
  const runner = options.runner ?? runExecutable;

  if (platform === "win32") {
    const probe = await probeWindowsTask(ownedSpec, runner, home);
    if (probe.blocking || !probe.exists) {
      return {
        plan,
        unitWritten: plan.unitPath,
        commandResults: [probe.blocking ?? probe.query],
        metadataPresent: await metadataPresent(plan),
      };
    }
  }

  return {
    plan,
    unitWritten: plan.unitPath,
    commandResults: await runAll(plan.stopCommands, runner),
    metadataPresent: await metadataPresent(plan),
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
