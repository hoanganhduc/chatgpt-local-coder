/**
 * macOS: a per-user LaunchAgent.
 *
 * A LaunchAgent in `~/Library/LaunchAgents` runs as the logged-in user and
 * needs no elevation. A LaunchDaemon would run as root and is deliberately not
 * used.
 */

import os from "os";
import path from "path";

import type { ServicePlan, ServiceSpec } from "./types.js";

export const LABEL = "com.chatgpt-local-coder";

export function launchdPlistPath(home: string = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Escape the five characters XML 1.0 reserves. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchAgent(spec: ServiceSpec): string {
  const argv = [spec.execPath, ...spec.args].map((part) => `      <string>${xml(part)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

export function launchdPlan(spec: ServiceSpec, home: string = os.homedir()): ServicePlan {
  const plistPath = launchdPlistPath(home);
  const target = `gui/${process.getuid?.() ?? 501}/${LABEL}`;

  return {
    mechanism: "launchd-agent",
    unitPath: plistPath,
    content: renderLaunchAgent(spec),
    installCommands: [
      ["launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath]],
      ["launchctl", ["enable", target]],
    ],
    uninstallCommands: [["launchctl", ["bootout", target]]],
    stopCommands: [["launchctl", ["kill", "SIGTERM", target]]],
    statusCommand: ["launchctl", ["print", target]],
    notes: [
      "`launchctl bootstrap` replaces the deprecated `load`; on older macOS use `launchctl load -w <plist>`.",
    ],
  };
}
