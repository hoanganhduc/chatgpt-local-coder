/**
 * `up`, `down`, `status`.
 *
 * `up` runs in the foreground and owns two children at most: the MCP server
 * process and, unless `--no-tunnel`, a tunnel runtime that tunnel-client
 * supervises on its own. Ctrl-C stops both — the tunnel through `runtimes stop`
 * rather than a signal, because this process is not its parent.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { loadConfig } from "../../config/load.js";
import { stateDir } from "../../config/paths.js";
import { platformId } from "../../lib/platform.js";
import { serviceStatus } from "../../services/index.js";
import { resolveTunnelBinary, tunnelConnect, tunnelStatus, tunnelStop } from "../../tunnel/index.js";
import { flag, integer, optionalString, parseCommand, UsageError, type CommandSpec } from "../args.js";
import { defaultServiceSpec } from "./service.js";
import { describeConnect, planConnect } from "./tunnel.js";

/** `dist/cli/commands/serve.js` -> `dist/index.js`. */
export function serverEntryPoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.js");
}

export const UP_SPEC: CommandSpec = {
  name: "up",
  summary: "Run the MCP server in the foreground, with the tunnel unless told otherwise.",
  options: {
    "no-tunnel": { type: "boolean", description: "Do not connect a tunnel runtime." },
    port: { type: "string", description: "Override the MCP port for this run.", placeholder: "n" },
    workspace: { type: "string", multiple: true, description: "Override the workspace roots.", placeholder: "path" },
    profile: { type: "string", description: "Override the permission profile.", placeholder: "name" },
    "tool-profile": { type: "string", description: "slim or full.", placeholder: "name" },
  },
};

export const DOWN_SPEC: CommandSpec = {
  name: "down",
  summary: "Stop the tunnel runtime and any service-managed server.",
  options: {
    alias: { type: "string", description: "Runtime alias. Defaults to tunnel.alias.", placeholder: "name" },
  },
};

export const STATUS_SPEC: CommandSpec = {
  name: "status",
  summary: "Report server health, tunnel runtime state, and session count.",
  options: { json: { type: "boolean", description: "Emit JSON." } },
};

/**
 * Flags reach the child as environment variables because the server reads its
 * own layered config; passing argv would need a second parser that could drift
 * from this one.
 */
function childEnv(values: ReturnType<typeof parseCommand>["values"], cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  const port = integer(values, "port");
  if (port !== undefined) env.PORT = String(port);

  const workspaces = Array.isArray(values.workspace)
    ? values.workspace
    : typeof values.workspace === "string"
      ? [values.workspace]
      : [];
  if (workspaces.length) {
    env.WORKSPACE_PATH = workspaces.map((p) => path.resolve(cwd, p)).join(path.delimiter);
  }

  const profile = optionalString(values, "profile");
  if (profile) env.CLC_PERMISSION_PROFILE = profile;

  const toolProfile = optionalString(values, "tool-profile");
  if (toolProfile) env.CHATGPT_TOOL_PROFILE = toolProfile;

  return env;
}

async function waitForHealth(port: number, deadlineMs = 20_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function runUp(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, UP_SPEC);
  const env = childEnv(parsed.values, cwd);
  const { config } = loadConfig({ cwd, overrides: {} });
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : config.port;

  const entry = serverEntryPoint();
  try {
    await fs.access(entry);
  } catch {
    throw new UsageError(`server entry point is missing: ${entry}. Run \`npm run build\` first.`);
  }

  const child: ChildProcess = spawn(process.execPath, [entry], { cwd, env, stdio: "inherit" });

  let tunnelBinary: string | undefined;
  let tunnelAlias: string | undefined;
  let stopping = false;

  const shutdown = async (code: number): Promise<never> => {
    if (stopping) process.exit(code);
    stopping = true;

    if (tunnelBinary && tunnelAlias) {
      console.log("\nStopping the tunnel runtime...");
      await tunnelStop({ binary: tunnelBinary }, tunnelAlias).catch(() => undefined);
    }
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");

    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const childExit = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      // A signalled exit arrives with a null code, which used to be reported as
      // a plain failure — so a restart, an OOM kill and a genuine crash all left
      // the same "exited 1" in the log and none of them could be told apart.
      if (signal) {
        console.error(`Server was terminated by ${signal}.`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
    child.on("error", (error) => {
      console.error(`Server failed to start: ${error.message}`);
      resolve(1);
    });
  });

  if (!flag(parsed.values, "no-tunnel")) {
    if (!(await waitForHealth(port))) {
      console.error(`Server did not answer on 127.0.0.1:${port} — not connecting a tunnel.`);
    } else {
      const resolved = await resolveTunnelBinary({ binPath: config.tunnel.binPath, download: false });
      if (!resolved.path) {
        console.error(
          `Tunnel skipped: ${resolved.error ?? "tunnel-client is not installed"}. Run \`chatgpt-local-coder tunnel init\`, or pass --no-tunnel to silence this.`
        );
      } else {
        try {
          const plan = await planConnect({ cwd });
          await fs.mkdir(plan.profileDir, { recursive: true });
          tunnelBinary = resolved.path;
          tunnelAlias = plan.alias;
          console.log(describeConnect(await tunnelConnect({ binary: resolved.path }, plan)));
        } catch (error) {
          console.error(`Tunnel skipped: ${error instanceof Error ? error.message : String(error)}`);
          tunnelBinary = undefined;
          tunnelAlias = undefined;
        }
      }
    }
  }

  const code = await childExit;
  if (!stopping && tunnelBinary && tunnelAlias) {
    await tunnelStop({ binary: tunnelBinary }, tunnelAlias).catch(() => undefined);
  }
  return code;
}

export async function runDown(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, DOWN_SPEC);
  const { config } = loadConfig({ cwd });
  const alias = optionalString(parsed.values, "alias") ?? config.tunnel.alias;

  let failures = 0;

  const resolved = await resolveTunnelBinary({ binPath: config.tunnel.binPath, download: false });
  if (resolved.path) {
    const result = await tunnelStop({ binary: resolved.path }, alias);
    console.log(result.ok ? `Tunnel runtime "${alias}" stopped.` : `Tunnel stop failed: ${result.stderr || result.stdout}`);
    if (!result.ok) failures++;
  } else {
    console.log("Tunnel: tunnel-client is not installed, nothing to stop.");
  }

  const spec = defaultServiceSpec(cwd);
  const status = await serviceStatus(spec);
  if (!status.installed) {
    console.log("Service: not installed, nothing to stop.");
    return failures ? 1 : 0;
  }

  const { servicePlan } = await import("../../services/index.js");
  const { runExecutable } = await import("../../lib/platform.js");
  for (const [command, args] of servicePlan(spec).stopCommands) {
    const run = await runExecutable(command, args, { timeoutMs: 30_000 });
    if (run.exitCode !== 0) {
      console.error(`${command} ${args.join(" ")} exited ${run.exitCode}: ${run.stderr}`);
      failures++;
    }
  }
  if (!failures) console.log("Service stopped.");

  return failures ? 1 : 0;
}

export async function runStatus(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, STATUS_SPEC);
  const { config } = loadConfig({ cwd });

  let health: Record<string, unknown> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2500) });
    if (response.ok) health = (await response.json()) as Record<string, unknown>;
  } catch {
    /* not running */
  }

  const resolved = await resolveTunnelBinary({ binPath: config.tunnel.binPath, download: false });
  const tunnel = resolved.path
    ? await tunnelStatus({ binary: resolved.path }, config.tunnel.alias)
    : undefined;

  const service = await serviceStatus(defaultServiceSpec(cwd));

  const summary = {
    server: health
      ? {
          running: true,
          port: config.port,
          workspace: health.workspace,
          permissionProfile: health.permissionProfile,
          activeSessions: health.activeSessions,
        }
      : { running: false, port: config.port },
    tunnel: resolved.path
      ? { binary: resolved.path, alias: config.tunnel.alias, healthy: tunnel?.json?.healthy ?? false, state: tunnel?.json?.state }
      : { binary: null, alias: config.tunnel.alias, healthy: false },
    service: { mechanism: service.mechanism, installed: service.installed, running: service.running },
    stateDir: stateDir(),
    platform: platformId(),
  };

  if (flag(parsed.values, "json")) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.server.running ? 0 : 1;
  }

  console.log(
    summary.server.running
      ? `Server:  running on 127.0.0.1:${config.port}, ${health?.activeSessions ?? 0} session(s), profile ${health?.permissionProfile}`
      : `Server:  not running (port ${config.port})`
  );
  console.log(
    resolved.path
      ? `Tunnel:  alias ${config.tunnel.alias} — ${summary.tunnel.healthy ? "healthy" : tunnel?.json?.state ?? "not connected"}`
      : "Tunnel:  tunnel-client is not installed"
  );
  console.log(
    `Service: ${service.mechanism} — ${service.installed ? (service.running ? "installed, running" : "installed, stopped") : "not installed"}`
  );

  return summary.server.running ? 0 : 1;
}
