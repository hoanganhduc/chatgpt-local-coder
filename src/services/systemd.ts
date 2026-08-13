/**
 * Linux: a systemd **user** unit.
 *
 * A user unit needs no elevation and dies with the user's session unless
 * lingering is enabled, which matches the user-scoped model the host uses
 * everywhere else. Nothing here installs a system unit.
 */

import os from "os";
import path from "path";

import type { ServicePlan, ServiceSpec, ServiceRole } from "./types.js";

export const UNIT_NAME = "chatgpt-local-coder.service";
export const TUNNEL_UNIT_NAME = "chatgpt-local-coder-tunnel.service";

export function systemdUnitName(role: ServiceRole = "host"): string {
  return role === "tunnel" ? TUNNEL_UNIT_NAME : UNIT_NAME;
}

export function systemdUnitPath(home: string = os.homedir(), role: ServiceRole = "host"): string {
  return path.join(home, ".config", "systemd", "user", systemdUnitName(role));
}

/** systemd reads `Environment=` verbatim; quote so spaces survive. */
function environmentLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `Environment="${key}=${value.replace(/"/g, '\\"')}"`)
    .join("\n");
}

function commandLine(execPath: string, args: string[]): string {
  return [execPath, ...args].map((part) => (part.includes(" ") ? `"${part}"` : part)).join(" ");
}

/**
 * The tunnel unit.
 *
 * `tunnel connect` returns once the configured runtime reports healthy, and
 * tunnel-client supervises that runtime from then on — outside this unit's
 * control group, because it daemonizes the runtime into its own session. Three
 * consequences are encoded here:
 *
 *   - `Type=oneshot` with `RemainAfterExit=yes`, so the runtime is not reaped
 *     when ExecStart returns and the unit still reads as active afterwards.
 *   - an explicit `ExecStop`, because stopping the unit cannot reach a process
 *     outside its control group; only `tunnel stop` can.
 *   - `Restart=on-failure`, which is the whole boot-race strategy: `connect`
 *     exits non-zero when the runtime is not healthy, so a boot that comes up
 *     before the network does retries instead of silently ending tunnel-less.
 *
 * There is deliberately no `After=network-online.target`: that target does not
 * exist in the systemd **user** manager, so ordering against it is a no-op that
 * reads like a guarantee.
 */
function renderTunnelUnit(spec: ServiceSpec): string {
  // The CLI uninstall performs the authoritative explicit stop after removing
  // the wrapper. Ignore an ExecStop failure here (including "already stopped")
  // so `disable --now` cannot suppress that independently checked cleanup.
  const stop = spec.stopArgs ? `ExecStop=-${commandLine(spec.execPath, spec.stopArgs)}\n` : "";

  return `[Unit]
Description=${spec.description}
# The host owns the MCP server; this unit only publishes it. Wants= rather than
# Requires= so restarting the host does not tear the tunnel down with it.
After=${UNIT_NAME}
Wants=${UNIT_NAME}
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${commandLine(spec.execPath, spec.args)}
${stop}WorkingDirectory=${spec.workingDirectory}
${environmentLines(spec.env)}
Restart=on-failure
RestartSec=15
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  if (spec.role === "tunnel") return renderTunnelUnit(spec);

  return `[Unit]
Description=${spec.description}
# No After=network-online.target: that target does not exist in the user
# manager, so ordering against it would be a no-op dressed up as a guarantee.

[Service]
Type=simple
ExecStart=${commandLine(spec.execPath, spec.args)}
WorkingDirectory=${spec.workingDirectory}
${environmentLines(spec.env)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

export function systemdPlan(spec: ServiceSpec, home: string = os.homedir()): ServicePlan {
  const role = spec.role ?? "host";
  const unit = systemdUnitName(role);

  return {
    mechanism: "systemd-user",
    unitPath: systemdUnitPath(home, role),
    content: renderSystemdUnit(spec),
    installCommands: [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", unit]],
    ],
    uninstallCommands: [
      ["systemctl", ["--user", "disable", "--now", unit]],
      ["systemctl", ["--user", "daemon-reload"]],
    ],
    stopCommands: [["systemctl", ["--user", "stop", unit]]],
    statusCommand: ["systemctl", ["--user", "is-active", unit]],
    notes: [
      "The unit stops when the user logs out unless `loginctl enable-linger` is set for this account.",
      ...(role === "tunnel"
        ? [
            "The runtime runs outside this unit's control group, so systemd cannot observe it dying; the unit stays active while `chatgpt-local-coder status` is the honest check.",
          ]
        : []),
    ],
  };
}
