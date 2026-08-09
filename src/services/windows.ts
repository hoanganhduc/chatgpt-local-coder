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

import os from "os";
import path from "path";

import { isWindowsBatchTarget, windowsSystemTool } from "../lib/platform.js";
import type { ServiceCommand, ServicePlan, ServiceSpec } from "./types.js";

export const TASK_NAME = "ChatGPTLocalCoder";
export const TASK_OWNERSHIP_MARKER = "Managed by chatgpt-local-coder (task schema v1)";

export function taskXmlPath(home: string = os.homedir()): string {
  return path.join(home, "AppData", "Local", "chatgpt-local-coder", `${TASK_NAME}.xml`);
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

function encodedLauncher(spec: ServiceSpec): string {
  if (!path.win32.isAbsolute(spec.execPath) || isWindowsBatchTarget(spec.execPath)) {
    throw new Error(`Windows service tasks require an absolute native executable, got ${JSON.stringify(spec.execPath)}`);
  }
  for (const value of [spec.execPath, spec.workingDirectory]) {
    if (value.includes("\0")) throw new Error("Windows service paths cannot contain NUL");
  }
  for (const [name, value] of Object.entries(spec.env)) {
    if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) {
      throw new Error(`Windows service environment variable ${JSON.stringify(name)} is not representable`);
    }
  }

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

/**
 * Task Scheduler has no environment block. An absolute Windows PowerShell 5.1
 * launcher decodes an opaque payload and starts the native executable through
 * ProcessStartInfo; no value is interpolated into shell source.
 */
export function renderTaskXml(spec: ServiceSpec, env: NodeJS.ProcessEnv = process.env): string {
  const user = os.userInfo().username;
  const powershell = windowsSystemTool(path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
  const command = `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedLauncher(spec)}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`${spec.description} — ${TASK_OWNERSHIP_MARKER}`)}</Description>
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
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(powershell)}</Command>
      <Arguments>${xml(command)}</Arguments>
      <WorkingDirectory>${xml(spec.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Query the registered definition before replacing or deleting a fixed-name task. */
export function windowsTaskQueryCommand(env: NodeJS.ProcessEnv = process.env): ServiceCommand {
  return [windowsSystemTool("schtasks.exe", env), ["/Query", "/TN", TASK_NAME, "/XML"]];
}

/**
 * New tasks carry a stable marker. The second branch recognizes definitions
 * created by releases before that marker existed so they can be upgraded once.
 */
export function isOwnedWindowsTask(taskXml: string, spec: ServiceSpec): boolean {
  const fields = ["Description", "Command", "Arguments", "WorkingDirectory"];
  const expected = renderTaskXml(spec);
  if (fields.every((tag) => xmlElementText(taskXml, tag) === xmlElementText(expected, tag))) return true;

  // Releases before the ownership marker used one exact cmd.exe action. Match
  // its structured fields once so an existing installation can be upgraded;
  // scattered marker/path substrings never establish ownership.
  const legacyEnv = Object.entries(spec.env)
    .map(([key, value]) => `set ${key}=${value}&& `)
    .join("");
  const legacyArgs = spec.args.map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" ");
  const legacyCommand = `/c ${legacyEnv}"${spec.execPath}" ${legacyArgs}`;
  return (
    xmlElementText(taskXml, "Description") === spec.description &&
    xmlElementText(taskXml, "Command")?.toLowerCase() === "cmd.exe" &&
    xmlElementText(taskXml, "Arguments") === legacyCommand &&
    xmlElementText(taskXml, "WorkingDirectory") === spec.workingDirectory
  );
}

export function windowsPlan(
  spec: ServiceSpec,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): ServicePlan {
  const xmlPath = taskXmlPath(home);
  const schtasks = windowsSystemTool("schtasks.exe", env);
  return {
    mechanism: "schtasks-logon",
    unitPath: xmlPath,
    content: renderTaskXml(spec, env),
    // The installer adds /F only after an existing definition passes the
    // ownership check. A missing or unreadable task can never be overwritten.
    installCommands: [[schtasks, ["/Create", "/TN", TASK_NAME, "/XML", xmlPath]]],
    uninstallCommands: [[schtasks, ["/Delete", "/TN", TASK_NAME, "/F"]]],
    stopCommands: [[schtasks, ["/End", "/TN", TASK_NAME]]],
    statusCommand: [schtasks, ["/Query", "/TN", TASK_NAME, "/FO", "LIST"]],
    notes: [
      "A logon task, not a Windows Service: it starts when this user logs on and stops at logoff.",
      "Installing a real service would need elevation and a service-host wrapper.",
    ],
  };
}
