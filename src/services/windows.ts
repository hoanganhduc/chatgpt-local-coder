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

import type { ServicePlan, ServiceSpec } from "./types.js";

export const TASK_NAME = "ChatGPTLocalCoder";

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

/** schtasks quotes arguments as one string; quote any part containing a space. */
function argumentString(args: string[]): string {
  return args.map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" ");
}

/**
 * Task Scheduler has no environment block, so the variables are prepended as a
 * `cmd /c set ... &&` wrapper. Everything the host needs is already in the
 * config file; this carries only what must differ per install.
 */
export function renderTaskXml(spec: ServiceSpec): string {
  const user = process.env.USERNAME || os.userInfo().username;
  // Written as raw `&&`; the whole command string is XML-escaped once below.
  const env = Object.entries(spec.env)
    .map(([key, value]) => `set ${key}=${value}&& `)
    .join("");
  const command = `${env}"${spec.execPath}" ${argumentString(spec.args)}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(spec.description)}</Description>
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
      <Command>cmd.exe</Command>
      <Arguments>/c ${xml(command)}</Arguments>
      <WorkingDirectory>${xml(spec.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function windowsPlan(spec: ServiceSpec, home: string = os.homedir()): ServicePlan {
  const xmlPath = taskXmlPath(home);
  return {
    mechanism: "schtasks-logon",
    unitPath: xmlPath,
    content: renderTaskXml(spec),
    installCommands: [["schtasks", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]]],
    uninstallCommands: [["schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]]],
    stopCommands: [["schtasks", ["/End", "/TN", TASK_NAME]]],
    statusCommand: ["schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST"]],
    notes: [
      "A logon task, not a Windows Service: it starts when this user logs on and stops at logoff.",
      "Installing a real service would need elevation and a service-host wrapper.",
    ],
  };
}
