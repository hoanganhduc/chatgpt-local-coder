/**
 * tunnel-client managed-runtime lifecycle.
 *
 * The tunnel is not supervised by this host. `runtimes connect` hands the
 * process to tunnel-client's own supervisor, and everything here is a thin,
 * argv-exact wrapper over that contract:
 *
 *   runtimes create  --alias <alias> [--name ...] [--description ...] --json
 *   runtimes connect --alias <alias> --profile <name> --profile-dir <dir>
 *                    --mcp-server-url <url> --runtime-api-key <ref>
 *                    [--tunnel-id <id>] --json
 *   runtimes status  <alias> --json
 *   runtimes stop    <alias> --json
 *   runtimes rm      <alias> --json
 *
 * Two rules matter more than the rest:
 *
 *   - `--runtime-api-key` and `--admin-key` take a *reference* (`env:NAME` or
 *     `file:/path`), never key material. The client rejects inline secrets, and
 *     passing one would put it in this process's argv where any local user
 *     could read it.
 *   - `connect` starts a background runtime as a side effect. Nothing may call
 *     it speculatively — not to probe the binary, not to render help.
 */

import fs from "fs/promises";
import path from "path";

import { configDir } from "../config/paths.js";
import { runExecutable, type RunResult } from "../lib/platform.js";

/** How long `connect` waits for the runtime to report healthy. */
export const HEALTH_DEADLINE_MS = 30_000;
const HEALTH_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 40;

const KEY_REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/;

/**
 * Reject anything that is not a reference form. The offending value is never
 * included in the message: if the caller got this wrong, the value is most
 * likely a live key.
 */
export function assertKeyReference(value: string, flag: string): void {
  if (!KEY_REFERENCE.test(value)) {
    throw new Error(`${flag} accepts only env:NAME or file:/path, not literal key material`);
  }
}

export function defaultProfileDir(): string {
  return path.join(configDir(), "tunnel-profiles");
}

export interface CreateArgsOptions {
  alias: string;
  name?: string;
  description?: string;
  /** `env:NAME` or `file:/path`. */
  adminKey?: string;
}

export function buildCreateArgs(opts: CreateArgsOptions): string[] {
  if (opts.adminKey) assertKeyReference(opts.adminKey, "--admin-key");

  const args = ["runtimes", "create", "--alias", opts.alias];
  if (opts.name) args.push("--name", opts.name);
  if (opts.description) args.push("--description", opts.description);
  // Creating an alias is a control-plane write, so it needs an admin key unless
  // tunnel-client already has an active admin profile to fall back on.
  if (opts.adminKey) args.push("--admin-key", opts.adminKey);
  args.push("--json");
  return args;
}

export interface ConnectArgsOptions {
  alias: string;
  profile: string;
  profileDir: string;
  mcpServerUrl: string;
  /** `env:NAME` or `file:/path`. */
  runtimeApiKey: string;
  tunnelId?: string;
  /** `env:NAME` or `file:/path`. */
  adminKey?: string;
}

export function buildConnectArgs(opts: ConnectArgsOptions): string[] {
  assertKeyReference(opts.runtimeApiKey, "--runtime-api-key");
  if (opts.adminKey) assertKeyReference(opts.adminKey, "--admin-key");

  const args = [
    "runtimes",
    "connect",
    "--alias",
    opts.alias,
    "--profile",
    opts.profile,
    "--profile-dir",
    opts.profileDir,
    "--mcp-server-url",
    opts.mcpServerUrl,
    "--runtime-api-key",
    opts.runtimeApiKey,
  ];
  if (opts.tunnelId) args.push("--tunnel-id", opts.tunnelId);
  if (opts.adminKey) args.push("--admin-key", opts.adminKey);
  args.push("--json");
  return args;
}

export function buildStatusArgs(alias: string): string[] {
  return ["runtimes", "status", alias, "--json"];
}

export function buildStopArgs(alias: string): string[] {
  return ["runtimes", "stop", alias, "--json"];
}

export function buildRemoveArgs(alias: string): string[] {
  return ["runtimes", "rm", alias, "--json"];
}

export interface RuntimeJson {
  healthy?: boolean;
  health_url?: string;
  config_path?: string;
  tunnel_id?: string;
  alias?: string;
  state?: string;
  launch_diagnostics?: { log_path?: string };
  [key: string]: unknown;
}

export interface TunnelCommandResult {
  ok: boolean;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  json?: RuntimeJson;
  stdout: string;
  stderr: string;
  error?: string;
}

/** The client prints JSON on stdout, sometimes after unstructured log lines. */
function parseRuntimeJson(stdout: string): RuntimeJson | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as RuntimeJson;
  } catch {
    /* fall through to the brace scan */
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as RuntimeJson;
  } catch {
    return undefined;
  }
}

function toResult(args: string[], run: RunResult): TunnelCommandResult {
  return {
    ok: run.exitCode === 0,
    args,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    json: parseRuntimeJson(run.stdout),
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

export interface RunTunnelOptions {
  binary: string;
  timeoutMs?: number;
  cwd?: string;
}

async function runTunnel(opts: RunTunnelOptions, args: string[]): Promise<TunnelCommandResult> {
  const run = await runExecutable(opts.binary, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return toResult(args, run);
}

export function tunnelCreate(opts: RunTunnelOptions, args: CreateArgsOptions): Promise<TunnelCommandResult> {
  return runTunnel(opts, buildCreateArgs(args));
}

export function tunnelStatus(opts: RunTunnelOptions, alias: string): Promise<TunnelCommandResult> {
  return runTunnel(opts, buildStatusArgs(alias));
}

export function tunnelStop(opts: RunTunnelOptions, alias: string): Promise<TunnelCommandResult> {
  return runTunnel(opts, buildStopArgs(alias));
}

export function tunnelRemove(opts: RunTunnelOptions, alias: string): Promise<TunnelCommandResult> {
  return runTunnel(opts, buildRemoveArgs(alias));
}

/** Last few lines of the runtime's own log, for when connect does not come up. */
export async function readLogTail(logPath: string | undefined, lines = LOG_TAIL_LINES): Promise<string | undefined> {
  if (!logPath) return undefined;
  try {
    const text = await fs.readFile(logPath, "utf-8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return undefined;
  }
}

export interface ConnectResult extends TunnelCommandResult {
  healthy: boolean;
  healthUrl?: string;
  configPath?: string;
  logPath?: string;
  logTail?: string;
  /** How long the health poll took, in milliseconds. */
  waitedMs?: number;
}

/**
 * Connect, then poll `runtimes status` until the runtime reports healthy or the
 * deadline passes. The client's own guidance is to check status before claiming
 * success, so a bare exit 0 from `connect` is not treated as one.
 */
export async function tunnelConnect(
  opts: RunTunnelOptions,
  args: ConnectArgsOptions,
  deadlineMs = HEALTH_DEADLINE_MS
): Promise<ConnectResult> {
  const connect = await runTunnel(opts, buildConnectArgs(args));
  const logPath = connect.json?.launch_diagnostics?.log_path;

  if (!connect.ok) {
    return {
      ...connect,
      healthy: false,
      healthUrl: connect.json?.health_url,
      configPath: connect.json?.config_path,
      logPath,
      logTail: await readLogTail(logPath),
    };
  }

  let healthy = connect.json?.healthy === true;
  let latest = connect;
  const started = Date.now();

  while (!healthy && Date.now() - started < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    latest = await tunnelStatus(opts, args.alias);
    healthy = latest.json?.healthy === true;
  }

  const finalLogPath = latest.json?.launch_diagnostics?.log_path ?? logPath;

  return {
    ...latest,
    ok: connect.ok,
    args: connect.args,
    healthy,
    healthUrl: latest.json?.health_url ?? connect.json?.health_url,
    configPath: latest.json?.config_path ?? connect.json?.config_path,
    logPath: finalLogPath,
    // A healthy runtime does not need its log read; a failed one is the whole
    // reason the caller is looking.
    logTail: healthy ? undefined : await readLogTail(finalLogPath),
    waitedMs: Date.now() - started,
  };
}
