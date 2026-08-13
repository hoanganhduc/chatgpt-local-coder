/** Shared shapes for the three service back ends. */

/**
 * Which of the two units a spec describes.
 *
 * They are separate units rather than one because the host is a long-running
 * process and the tunnel is a command that returns as soon as the configured
 * runtime reports healthy — tunnel-client supervises that runtime itself. One
 * unit covering both would have to lie about the type of one of them, and a
 * host restart would drop the tunnel with it.
 */
export type ServiceRole = "host" | "tunnel";

export interface ServiceSpec {
  /** Absolute path to the executable — normally the Node binary. */
  execPath: string;
  /** Argv after the executable, normally `[<cli entry>, "up", "--no-tunnel"]`. */
  args: string[];
  workingDirectory: string;
  description: string;
  logPath: string;
  env: Record<string, string>;
  /** Defaults to "host" when absent, which is what every caller meant before. */
  role?: ServiceRole;
  /**
   * Argv for the stop command, when stopping the unit is not enough to stop
   * the runtime whose lifecycle this service claims. The tunnel runtime is not
   * in the unit's process tree, so only `tunnel stop` reaches it.
   */
  stopArgs?: string[];
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
