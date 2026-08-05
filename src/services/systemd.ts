/**
 * Linux: a systemd **user** unit.
 *
 * A user unit needs no elevation and dies with the user's session unless
 * lingering is enabled, which matches the user-scoped model the host uses
 * everywhere else. Nothing here installs a system unit.
 */

import os from "os";
import path from "path";

import type { ServicePlan, ServiceSpec } from "./types.js";

export const UNIT_NAME = "chatgpt-local-coder.service";

export function systemdUnitPath(home: string = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", UNIT_NAME);
}

/** systemd reads `Environment=` verbatim; quote so spaces survive. */
function environmentLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `Environment="${key}=${value.replace(/"/g, '\\"')}"`)
    .join("\n");
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = [spec.execPath, ...spec.args].map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" ");
  const env = environmentLines(spec.env);

  return `[Unit]
Description=${spec.description}
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${spec.workingDirectory}
${env}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

export function systemdPlan(spec: ServiceSpec, home: string = os.homedir()): ServicePlan {
  const unitPath = systemdUnitPath(home);
  return {
    mechanism: "systemd-user",
    unitPath,
    content: renderSystemdUnit(spec),
    installCommands: [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", UNIT_NAME]],
    ],
    uninstallCommands: [
      ["systemctl", ["--user", "disable", "--now", UNIT_NAME]],
      ["systemctl", ["--user", "daemon-reload"]],
    ],
    stopCommands: [["systemctl", ["--user", "stop", UNIT_NAME]]],
    statusCommand: ["systemctl", ["--user", "is-active", UNIT_NAME]],
    notes: [
      "The unit stops when the user logs out unless `loginctl enable-linger` is set for this account.",
    ],
  };
}
