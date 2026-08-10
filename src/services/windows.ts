/**
 * Windows: a `schtasks` logon task, not a Windows Service.
 *
 * Installing a true service requires elevation and a service-host wrapper that
 * answers the SCM's control messages — a Node process cannot do that on its
 * own. A logon task runs in the user's context with no elevation, which is the
 * same trust level as the systemd user unit and the LaunchAgent. The tradeoff
 * is real and is documented rather than hidden: the task starts at logon, not
 * at boot, and it stops when the user logs off.
 */

import { execFileSync } from "node:child_process";
import os from "os";
import path from "path";

import { isWindowsBatchTarget, windowsSystemTool } from "../lib/platform.js";
import type { ServiceCommand, ServicePlan, ServiceSpec } from "./types.js";
import { WINDOWS_LAUNCHER_BASENAME, WINDOWS_LAUNCHER_SOURCE_SHA256 } from "./windows-launcher.js";

export const TASK_NAME = "ChatGPTLocalCoder";
export const TASK_OWNERSHIP_MARKER = "Managed by chatgpt-local-coder (task schema v1)";

export function taskXmlPath(home: string = os.homedir()): string {
  return path.join(home, "AppData", "Local", "chatgpt-local-coder", `${TASK_NAME}.xml`);
}

export function windowsLauncherSourcePath(home: string = os.homedir()): string {
  return path.join(home, "AppData", "Local", "chatgpt-local-coder", "service", `${WINDOWS_LAUNCHER_BASENAME}.cs`);
}

export function windowsLauncherSupportDirectory(home: string = os.homedir()): string {
  return path.join(home, "AppData", "Local", "chatgpt-local-coder", "service");
}

export function windowsLauncherExecutablePath(
  home: string = os.homedir(),
  // A synchronous dry-run has no compiled binary to hash. Real installation
  // always passes the SHA-256 of freshly compiled, validated executable bytes.
  binarySha256: string = WINDOWS_LAUNCHER_SOURCE_SHA256
): string {
  if (!/^[a-f0-9]{64}$/i.test(binarySha256)) throw new Error("Windows launcher digest must be SHA-256 hex");
  return path.join(windowsLauncherSupportDirectory(home), `ChatGPTLocalCoderLauncher-${binarySha256.toLowerCase()}.exe`);
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlElementText(document: string, tag: string): string | undefined {
  const body = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(document)?.[1];
  return body
    ?.replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Quote one argument for the Microsoft C command-line parser used by native
 * Windows executables. Backslashes are literal except immediately before a
 * quote; the run before a quote is doubled, with one more slash escaping the
 * quote itself. The trailing run is doubled before the closing delimiter.
 */
function quoteWindowsArgument(value: string): string {
  if (value.includes("\0")) throw new Error("a Windows process argument cannot contain NUL");

  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function windowsArgumentLine(args: string[]): string {
  return args.map(quoteWindowsArgument).join(" ");
}

function validateWindowsSpec(spec: ServiceSpec): void {
  if (!path.win32.isAbsolute(spec.execPath) || isWindowsBatchTarget(spec.execPath)) {
    throw new Error(`Windows service tasks require an absolute native executable, got ${JSON.stringify(spec.execPath)}`);
  }
  if (!path.win32.isAbsolute(spec.workingDirectory) || !path.win32.isAbsolute(spec.logPath)) {
    throw new Error("Windows service working and log paths must be absolute");
  }
  for (const value of [spec.execPath, spec.workingDirectory, spec.logPath]) {
    if (value.includes("\0")) throw new Error("Windows service paths cannot contain NUL");
  }
  for (const [name, value] of Object.entries(spec.env)) {
    if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) {
      throw new Error(`Windows service environment variable ${JSON.stringify(name)} is not representable`);
    }
  }
}

function xmlElementTexts(document: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  for (const match of document.matchAll(pattern)) values.push(xmlElementText(`<${tag}>${match[1]}</${tag}>`, tag) ?? "");
  return values;
}

let cachedWindowsIdentity: { account: string; sid: string } | undefined;

function currentWindowsIdentity(env: NodeJS.ProcessEnv): { account: string; sid: string } | undefined {
  if (process.platform !== "win32") return undefined;
  if (cachedWindowsIdentity) return cachedWindowsIdentity;
  try {
    const whoami = windowsSystemTool("whoami.exe", env);
    const output = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }).trim();
    const match = /^"((?:[^"]|"")*)","(S-1-(?:\d+-)+\d+)"$/i.exec(output);
    if (!match) return undefined;
    cachedWindowsIdentity = {
      account: match[1].replace(/""/g, '"').toLowerCase(),
      sid: match[2].toLowerCase(),
    };
    return cachedWindowsIdentity;
  } catch {
    return undefined;
  }
}

function hasManagedTaskEnvelope(
  taskXml: string,
  visibility: "visible" | "hidden",
  env: NodeJS.ProcessEnv
): boolean {
  const expectedUser = os.userInfo().username.toLowerCase();
  const userIds = xmlElementTexts(taskXml, "UserId");
  const hidden = xmlElementText(taskXml, "Hidden");
  const runLevel = xmlElementText(taskXml, "RunLevel");
  const identity = userIds.some((value) => value.toLowerCase() !== expectedUser)
    ? currentWindowsIdentity(env)
    : undefined;
  const allowedUsers = new Set(
    [expectedUser, identity?.account, identity?.sid].filter((value): value is string => Boolean(value))
  );
  const normalizedUsers = userIds.length === 2 && userIds.every((value) => {
    return allowedUsers.has(value.toLowerCase());
  });
  const triggerKinds = [
    "BootTrigger",
    "CalendarTrigger",
    "EventTrigger",
    "IdleTrigger",
    "LogonTrigger",
    "RegistrationTrigger",
    "SessionStateChangeTrigger",
    "TimeTrigger",
  ];
  const actionKinds = ["ComHandler", "Exec", "SendEmail", "ShowMessage"];
  return (
    normalizedUsers &&
    xmlElementTexts(taskXml, "Triggers").length === 1 &&
    triggerKinds.reduce((count, tag) => count + xmlElementTexts(taskXml, tag).length, 0) === 1 &&
    xmlElementTexts(taskXml, "LogonTrigger").length === 1 &&
    xmlElementTexts(taskXml, "Principals").length === 1 &&
    xmlElementTexts(taskXml, "Principal").length === 1 &&
    xmlElementTexts(taskXml, "Actions").length === 1 &&
    actionKinds.reduce((count, tag) => count + xmlElementTexts(taskXml, tag).length, 0) === 1 &&
    xmlElementTexts(taskXml, "Exec").length === 1 &&
    xmlElementText(taskXml, "LogonType") === "InteractiveToken" &&
    (runLevel === undefined || runLevel === "LeastPrivilege") &&
    xmlElementText(taskXml, "MultipleInstancesPolicy") === "IgnoreNew" &&
    (visibility === "visible" ? hidden === undefined || hidden === "false" : hidden === "true")
  );
}

function encodedLauncher(spec: ServiceSpec): string {
  validateWindowsSpec(spec);

  const payload = Buffer.from(
    JSON.stringify({
      execPath: spec.execPath,
      argumentLine: windowsArgumentLine(spec.args),
      workingDirectory: spec.workingDirectory,
      env: spec.env,
    }),
    "utf-8"
  ).toString("base64");

  // Values cross the PowerShell boundary only as Base64 JSON data. Native
  // argv is built before this script and handed to ProcessStartInfo with shell
  // execution disabled, so PowerShell never reparses a path or argument.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    "  $payload = ConvertFrom-Json -InputObject $payloadJson",
    "  $start = New-Object System.Diagnostics.ProcessStartInfo",
    "  $start.FileName = [string]$payload.execPath",
    "  $start.Arguments = [string]$payload.argumentLine",
    "  $start.WorkingDirectory = [string]$payload.workingDirectory",
    "  $start.UseShellExecute = $false",
    "  foreach ($property in $payload.env.PSObject.Properties) {",
    "    $name = [string]$property.Name",
    "    $value = [string]$property.Value",
    "    $start.EnvironmentVariables[$name] = $value",
    "  }",
    "  $process = New-Object System.Diagnostics.Process",
    "  $process.StartInfo = $start",
    "  if (-not $process.Start()) { throw 'process did not start' }",
    "  $process.WaitForExit()",
    "  $exitCode = $process.ExitCode",
    "  $process.Dispose()",
    "  exit $exitCode",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");

  return Buffer.from(script, "utf16le").toString("base64");
}

function opaqueNativeLauncherPayload(spec: ServiceSpec): string {
  validateWindowsSpec(spec);
  const encodeField = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  };
  const fields = [spec.execPath, windowsArgumentLine(spec.args), spec.workingDirectory, spec.logPath].map(encodeField);
  const environment = Object.entries(spec.env).flatMap(([name, value]) => [encodeField(name), encodeField(value)]);
  const environmentCount = Buffer.allocUnsafe(4);
  environmentCount.writeInt32LE(Object.keys(spec.env).length, 0);
  return Buffer.concat([Buffer.from("CLC2", "ascii"), ...fields, environmentCount, ...environment]).toString("base64");
}

/**
 * Task Scheduler invokes only an app-owned GUI-subsystem executable. The
 * launcher receives one opaque structured payload, creates the configured
 * native executable with CREATE_NO_WINDOW, and propagates its exit status.
 */
export function renderTaskXml(
  spec: ServiceSpec,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  launcherExecutable: string = windowsLauncherExecutablePath(home)
): string {
  const user = os.userInfo().username;
  const command = opaqueNativeLauncherPayload(spec);

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`${spec.description} - ${TASK_OWNERSHIP_MARKER}`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(launcherExecutable)}</Command>
      <Arguments>${xml(command)}</Arguments>
      <WorkingDirectory>${xml(spec.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function renderWindowsPowerShellPredecessorTaskXml(
  spec: ServiceSpec,
  variant: "schema-v1" | "installed-window-hidden",
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  const powershell = windowsSystemTool(path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
  const { CLC_SERVICE_MODE: _serviceMode, ...historicalEnvironment } = spec.env;
  const predecessorSpec =
    variant === "installed-window-hidden"
      ? { ...spec, env: { ...spec.env, CLC_SERVICE_MODE: "1" } }
      : { ...spec, env: historicalEnvironment };
  const description =
    variant === "installed-window-hidden"
      ? `${spec.description} - ${TASK_OWNERSHIP_MARKER}`
      : `${spec.description} — ${TASK_OWNERSHIP_MARKER}`;
  const windowStyle = variant === "installed-window-hidden" ? " -WindowStyle Hidden" : "";
  const argumentsValue = `-NoLogo -NoProfile -NonInteractive${windowStyle} -EncodedCommand ${encodedLauncher(predecessorSpec)}`;
  return renderTaskXml(spec, env, home)
    .replace(/<Description>[\s\S]*?<\/Description>/, `<Description>${xml(description)}</Description>`)
    .replace(
      /<Hidden>false<\/Hidden>/,
      variant === "schema-v1" ? "<Hidden>true</Hidden>" : "<Hidden>false</Hidden>"
    )
    .replace(/<Command>[\s\S]*?<\/Command>/, `<Command>${xml(powershell)}</Command>`)
    .replace(/<Arguments>[\s\S]*?<\/Arguments>/, `<Arguments>${xml(argumentsValue)}</Arguments>`);
}

export function windowsLauncherCompileCommand(
  sourcePath: string,
  outputPath: string,
  env: NodeJS.ProcessEnv = process.env
): ServiceCommand {
  const powershell = windowsSystemTool(path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
  const payload = Buffer.from(JSON.stringify({ sourcePath, outputPath }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    "$paths = ConvertFrom-Json -InputObject $json",
    "if (Test-Path -LiteralPath ([string]$paths.outputPath)) { throw 'native launcher output already exists' }",
    "Add-Type -LiteralPath ([string]$paths.sourcePath) -OutputAssembly ([string]$paths.outputPath) -OutputType WindowsApplication",
    "if (-not (Test-Path -LiteralPath ([string]$paths.outputPath) -PathType Leaf)) { throw 'native launcher was not created' }",
  ].join("\n");
  return [
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  ];
}

/** Query the registered definition before replacing or deleting a fixed-name task. */
export function windowsTaskQueryCommand(env: NodeJS.ProcessEnv = process.env): ServiceCommand {
  return [windowsSystemTool("schtasks.exe", env), ["/Query", "/TN", TASK_NAME, "/XML"]];
}

export function windowsTaskLauncherExecutablePath(
  taskXml: string,
  spec: ServiceSpec,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const command = xmlElementText(taskXml, "Command");
  if (!command) return undefined;
  const expectedDirectory = path.resolve(windowsLauncherSupportDirectory(home)).toLowerCase();
  if (path.resolve(path.dirname(command)).toLowerCase() !== expectedDirectory) return undefined;
  if (!/^ChatGPTLocalCoderLauncher-[a-f0-9]{64}\.exe$/i.test(path.basename(command))) return undefined;

  const expected = renderTaskXml(spec, env, home, command);
  const fields = ["Description", "Arguments", "WorkingDirectory"];
  if (
    fields.every(
      (tag) =>
        xmlElementTexts(taskXml, tag).length === 1 &&
        xmlElementText(taskXml, tag) === xmlElementText(expected, tag)
    ) &&
    hasManagedTaskEnvelope(taskXml, "visible", env)
  ) {
    return command;
  }
  return undefined;
}

/**
 * New tasks carry a stable marker. The second branch recognizes definitions
 * created by releases before that marker existed so they can be upgraded once.
 */
export function isOwnedWindowsTask(
  taskXml: string,
  spec: ServiceSpec,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (windowsTaskLauncherExecutablePath(taskXml, spec, home, env)) return true;

  // Exact schema-v1 PowerShell actions are allowlisted solely for migration.
  // This includes the currently installed attempted fix with WindowStyle Hidden.
  const powershell = windowsSystemTool(path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
  const { CLC_SERVICE_MODE: _serviceMode, ...historicalEnvironment } = spec.env;
  const predecessors = [
    {
      description: `${spec.description} — ${TASK_OWNERSHIP_MARKER}`,
      arguments: `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedLauncher({
        ...spec,
        env: historicalEnvironment,
      })}`,
      visibility: "hidden" as const,
    },
    {
      description: `${spec.description} - ${TASK_OWNERSHIP_MARKER}`,
      arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedLauncher({
        ...spec,
        env: { ...spec.env, CLC_SERVICE_MODE: "1" },
      })}`,
      visibility: "visible" as const,
    },
  ];
  for (const predecessor of predecessors) {
    if (
      ["Description", "Command", "Arguments", "WorkingDirectory"].every(
        (tag) => xmlElementTexts(taskXml, tag).length === 1
      ) &&
      xmlElementText(taskXml, "Description") === predecessor.description &&
      xmlElementText(taskXml, "Command")?.toLowerCase() === powershell.toLowerCase() &&
      xmlElementText(taskXml, "Arguments") === predecessor.arguments &&
      xmlElementText(taskXml, "WorkingDirectory") === spec.workingDirectory &&
      hasManagedTaskEnvelope(taskXml, predecessor.visibility, env)
    ) {
      return true;
    }
  }

  // Pre-marker CMD tasks did not carry a complete principal/trigger envelope,
  // so their identity cannot be established safely enough for automatic /F,
  // /End, or /Delete. They must be removed manually once before migration.
  return false;
}

export function windowsPlan(
  spec: ServiceSpec,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  launcherExecutable: string = windowsLauncherExecutablePath(home)
): ServicePlan {
  const xmlPath = taskXmlPath(home);
  const schtasks = windowsSystemTool("schtasks.exe", env);
  return {
    mechanism: "schtasks-logon",
    unitPath: xmlPath,
    content: renderTaskXml(spec, env, home, launcherExecutable),
    // The installer adds /F only after an existing definition passes the
    // ownership check. A missing or unreadable task can never be overwritten.
    installCommands: [[schtasks, ["/Create", "/TN", TASK_NAME, "/XML", xmlPath]]],
    uninstallCommands: [[schtasks, ["/Delete", "/TN", TASK_NAME, "/F"]]],
    stopCommands: [[schtasks, ["/End", "/TN", TASK_NAME]]],
    statusCommand: [schtasks, ["/Query", "/TN", TASK_NAME, "/FO", "LIST"]],
    notes: [
      "A logon task, not a Windows Service: it starts when this user logs on and stops at logoff.",
      "Installing a real service would need elevation and a service-host wrapper.",
      "Dry-run XML uses an unresolved launcher template; real install compiles, validates, hashes, and publishes the GUI launcher before registration.",
    ],
  };
}
