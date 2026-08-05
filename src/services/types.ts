/** Shared shapes for the three service back ends. */

export interface ServiceSpec {
  /** Absolute path to the executable — normally the Node binary. */
  execPath: string;
  /** Argv after the executable, normally `[<cli entry>, "up", "--no-tunnel"]`. */
  args: string[];
  workingDirectory: string;
  description: string;
  logPath: string;
  env: Record<string, string>;
}

export type ServiceMechanism = "systemd-user" | "launchd-agent" | "schtasks-logon";

export type ServiceCommand = [string, string[]];

export interface ServicePlan {
  mechanism: ServiceMechanism;
  /** Where the unit / plist / task XML is written. */
  unitPath: string;
  content: string;
  installCommands: ServiceCommand[];
  uninstallCommands: ServiceCommand[];
  /** Stop without uninstalling — what `down` uses. */
  stopCommands: ServiceCommand[];
  statusCommand: ServiceCommand;
  /** Platform caveats worth printing rather than burying. */
  notes: string[];
}

export interface ServiceStatus {
  mechanism: ServiceMechanism;
  unitPath: string;
  installed: boolean;
  running: boolean;
  detail: string;
}
