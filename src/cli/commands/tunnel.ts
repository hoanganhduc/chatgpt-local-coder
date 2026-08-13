/**
 * `tunnel init|connect|status|stop|rm` — wrappers over the T10 runtime module.
 *
 * `connect` is the only one with a side effect beyond the control plane: it
 * starts a supervised background runtime. Nothing in this file calls it to
 * probe, render help, or check whether the binary works.
 */

import fs from "fs/promises";
import path from "path";

import { loadConfig } from "../../config/load.js";
import { healthUrlForMcpUrl, waitForMcpHealth } from "../../lib/port-probe.js";
import { getSecret, secretFileReference } from "../../lib/secrets.js";
import {
  defaultProfileDir,
  installTunnelBinary,
  readinessCaveat,
  resolveTunnelBinary,
  tunnelConnect,
  tunnelCreate,
  tunnelRemove,
  tunnelStatus,
  tunnelStop,
  type ConnectResult,
  type TunnelCommandResult,
} from "../../tunnel/index.js";
import { flag, integer, optionalString, parseCommand, UsageError, type CommandSpec } from "../args.js";

export const TUNNEL_SUBCOMMANDS = ["init", "connect", "status", "stop", "rm"];

export const TUNNEL_SPEC: CommandSpec = {
  name: "tunnel",
  summary: "Manage the tunnel-client runtime that publishes this host to ChatGPT.",
  usage: `<${TUNNEL_SUBCOMMANDS.join("|")}>`,
  detail:
    "`init` downloads and verifies the tunnel-client binary and creates the alias.\n" +
    "`connect` starts a supervised background runtime and waits for it to report healthy.",
  options: {
    alias: { type: "string", description: "Runtime alias. Defaults to tunnel.alias in the config.", placeholder: "name" },
    "admin-key": {
      type: "string",
      description: "Admin key reference for `init`, as env:NAME or file:/path. Never a literal key.",
      placeholder: "ref",
    },
    "tunnel-id": { type: "string", description: "Attach to an existing tunnel id.", placeholder: "id" },
    "mcp-url": { type: "string", description: "MCP URL to publish. Defaults to the configured port.", placeholder: "url" },
    profile: { type: "string", description: "Generated profile name. Defaults to the alias.", placeholder: "name" },
    "profile-dir": { type: "string", description: "Where generated profiles are written.", placeholder: "dir" },
    "wait-for-server": {
      type: "boolean",
      description: "Wait for the MCP server to answer before connecting.",
    },
    "wait-timeout": {
      type: "string",
      description: "Seconds to wait with --wait-for-server. Defaults to 60.",
      placeholder: "s",
    },
    json: { type: "boolean", description: "Emit the raw JSON result." },
  },
};

/** Resolve the binary, downloading only when the caller asked for it. */
async function requireBinary(binPath: string | undefined, download: boolean): Promise<string> {
  const resolved = await resolveTunnelBinary({ binPath, download });
  if (!resolved.path) {
    throw new UsageError(
      `${resolved.error ?? "tunnel-client is not installed"}. Run \`chatgpt-local-coder tunnel init\` first.`
    );
  }
  return resolved.path;
}

function report(result: TunnelCommandResult, asJson: boolean): number {
  if (asJson) {
    console.log(JSON.stringify(result.json ?? { stdout: result.stdout, stderr: result.stderr }, null, 2));
  } else {
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    // The runtime reports `healthy: true` for itself while recording separately
    // that it never reached the MCP host. Printing the JSON as-is buried that.
    const caveat = readinessCaveat(result.json);
    if (caveat) console.error(`WARNING: the runtime is up but not fully ready — ${caveat}`);
  }
  return result.ok ? 0 : 1;
}

export interface ConnectPlan {
  alias: string;
  profile: string;
  profileDir: string;
  mcpServerUrl: string;
  runtimeApiKey: string;
  tunnelId?: string;
}

/**
 * Build everything `connect` needs. The runtime key is passed as a
 * `file:<path>` reference produced by the secret store — the literal value
 * never reaches an argv.
 */
export async function planConnect(opts: {
  alias?: string;
  profile?: string;
  profileDir?: string;
  mcpUrl?: string;
  tunnelId?: string;
  cwd?: string;
}): Promise<ConnectPlan> {
  const { config } = loadConfig({ cwd: opts.cwd });
  const alias = opts.alias ?? config.tunnel.alias;

  const runtimeApiKey = await secretFileReference("OPENAI_TUNNEL_API_KEY");
  if (!runtimeApiKey) {
    throw new UsageError(
      "OPENAI_TUNNEL_API_KEY is not set. Export it, or add it to the secrets store, then retry."
    );
  }

  return {
    alias,
    profile: opts.profile ?? alias,
    profileDir: path.resolve(opts.profileDir ?? config.tunnel.profileDir ?? defaultProfileDir()),
    mcpServerUrl: opts.mcpUrl ?? `http://127.0.0.1:${config.port}/mcp`,
    runtimeApiKey,
    tunnelId: opts.tunnelId ?? (await getSecret("OPENAI_TUNNEL_ID")),
  };
}

export function describeConnect(result: ConnectResult): string {
  const lines = [
    result.healthy ? "Tunnel runtime is healthy." : "Tunnel runtime did not report healthy.",
    `  health url: ${result.healthUrl ?? "unknown"}`,
    `  config:     ${result.configPath ?? "unknown"}`,
  ];
  // "Healthy" is about the runtime, not about the host behind it. When the
  // runtime says it is ready but qualifies it, the qualification is the part
  // worth reading.
  if (result.readinessCaveat) {
    lines.push(`  WARNING:    the runtime is up but not fully ready — ${result.readinessCaveat}`);
    lines.push(`              check the host is running: chatgpt-local-coder status`);
  }
  if (result.logPath) lines.push(`  log:        ${result.logPath}`);
  if (result.waitedMs !== undefined) lines.push(`  waited:     ${Math.round(result.waitedMs / 1000)}s`);
  if (result.logTail) lines.push("", "Log tail:", result.logTail);
  return lines.join("\n");
}

export async function runTunnel(argv: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseCommand(argv, TUNNEL_SPEC);
  const sub = parsed.positionals[0];

  if (!sub) throw new UsageError(`tunnel needs a subcommand: ${TUNNEL_SUBCOMMANDS.join(", ")}`, TUNNEL_SPEC);
  if (!TUNNEL_SUBCOMMANDS.includes(sub)) throw new UsageError(`unknown tunnel subcommand "${sub}"`, TUNNEL_SPEC);

  const { config } = loadConfig({ cwd });
  const asJson = flag(parsed.values, "json");
  const alias = optionalString(parsed.values, "alias") ?? config.tunnel.alias;

  if (sub === "init") {
    const installed = await installTunnelBinary();
    console.log(`tunnel-client ${installed.version} at ${installed.path}`);
    if (!installed.verified) console.warn("WARNING: this release published no checksum; the download was not verified.");

    // Creating an alias is a control-plane write. The key reaches tunnel-client
    // as a reference, and only for this step — the long-lived daemon must never
    // be given an admin key.
    const adminKey = optionalString(parsed.values, "admin-key") ?? (await secretFileReference("OPENAI_ADMIN_KEY"));

    const created = await tunnelCreate({ binary: installed.path }, { alias, adminKey });
    if (!created.ok) {
      console.error(created.stderr || created.stdout);
      console.error(
        adminKey
          ? "Alias creation failed. Check that the admin key is valid and has permission to manage tunnels."
          : "Alias creation failed. `runtimes create` needs an admin key: pass `--admin-key env:NAME`,\n" +
            "store one as OPENAI_ADMIN_KEY, or create the tunnel at\n" +
            "https://platform.openai.com/settings/organization/tunnels and skip this step."
      );
      return 1;
    }
    console.log(`Alias "${alias}" is ready. Run \`chatgpt-local-coder tunnel connect\` to start the runtime.`);
    return 0;
  }

  const binary = await requireBinary(config.tunnel.binPath, false);

  if (sub === "connect") {
    const mcpUrl = optionalString(parsed.values, "mcp-url") ?? `http://127.0.0.1:${config.port}/mcp`;

    // A service-started tunnel races the host it publishes. Ordering the units
    // is not enough: a supervisor calls a unit started once its process has
    // forked, which is well before the server has bound its port, and the
    // runtime reports itself healthy while separately recording that it never
    // reached the MCP host — so the race resolves quietly into a tunnel that
    // points at nothing. Waiting here rather than in a per-platform ExecStartPre
    // keeps one implementation for all three service back ends.
    if (flag(parsed.values, "wait-for-server")) {
      const seconds = integer(parsed.values, "wait-timeout") ?? 60;
      if (seconds <= 0) {
        throw new UsageError(`--wait-timeout expects a positive number of seconds, got "${optionalString(parsed.values, "wait-timeout")}"`);
      }
      let healthUrl: string;
      try {
        healthUrl = healthUrlForMcpUrl(mcpUrl);
      } catch (error) {
        throw new UsageError(`--mcp-url is not a valid HTTP(S) URL: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!(await waitForMcpHealth(mcpUrl, seconds * 1000))) {
        console.error(
          `The MCP server did not answer at ${healthUrl} within ${seconds}s — not connecting a tunnel.`
        );
        console.error("Start it with `chatgpt-local-coder up`, or install it as a service first.");
        return 1;
      }
    }

    const plan = await planConnect({
      alias,
      profile: optionalString(parsed.values, "profile"),
      profileDir: optionalString(parsed.values, "profile-dir"),
      mcpUrl,
      tunnelId: optionalString(parsed.values, "tunnel-id"),
      cwd,
    });
    await fs.mkdir(plan.profileDir, { recursive: true });

    const result = await tunnelConnect({ binary }, plan);
    if (asJson) {
      console.log(JSON.stringify({ ...result, logTail: result.logTail }, null, 2));
    } else {
      console.log(describeConnect(result));
    }
    return result.healthy ? 0 : 1;
  }

  if (sub === "status") return report(await tunnelStatus({ binary }, alias), asJson);
  if (sub === "stop") return report(await tunnelStop({ binary }, alias), asJson);
  return report(await tunnelRemove({ binary }, alias), asJson);
}
