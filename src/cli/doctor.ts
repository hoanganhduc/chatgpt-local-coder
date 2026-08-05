/**
 * Environment diagnosis.
 *
 * Every check produces a finding at one of three levels. `error` means the host
 * will not work as configured; `warn` means a capability is unavailable but the
 * server still runs; `ok` is informational. The exit status is 0 only when no
 * finding is at `error`.
 *
 * Secrets appear here as `set` or `unset` and never as values — that is a
 * release gate, not a preference.
 */

import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";

import { loadConfig } from "../config/load.js";
import { configFilePath, configDir, stateDir, cacheDir } from "../config/paths.js";
import { detectDelegates } from "../delegates/index.js";
import { archId, platformId, which } from "../lib/platform.js";
import { listSecretNames, secretsPath } from "../lib/secrets.js";
import { loadSkillRegistry } from "../skills/registry.js";
import { loadSettings, resetSettings } from "../settings/index.js";
import { resolveTunnelBinary } from "../tunnel/release.js";

export type FindingLevel = "ok" | "warn" | "error";

export interface Finding {
  id: string;
  level: FindingLevel;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  node: string;
  paths: { config: string; state: string; cache: string; configFile: string; secrets: string };
  findings: Finding[];
}

/** Secrets the host knows how to use. Presence only — never the value. */
export const KNOWN_SECRETS = ["OPENAI_TUNNEL_API_KEY", "OPENAI_TUNNEL_ID", "ADMIN_TOKEN", "OPENAI_ADMIN_KEY"];

const MINIMUM_NODE_MAJOR = 20;

async function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(1500);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

/** Whether the thing on the port is this host rather than an unrelated process. */
async function isOurServer(port: number, host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { name?: string };
    return body.name === "codex-mcp-server";
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  add(
    nodeMajor >= MINIMUM_NODE_MAJOR
      ? { id: "node", level: "ok", message: `Node ${process.versions.node}` }
      : {
          id: "node",
          level: "error",
          message: `Node ${process.versions.node} is too old`,
          detail: `Node ${MINIMUM_NODE_MAJOR} or newer is required.`,
        }
  );

  const loaded = loadConfig({ cwd });
  const { config } = loaded;

  for (const layer of loaded.layers) {
    if (layer.error) {
      add({
        id: `config:${layer.id}`,
        level: "error",
        message: `${layer.id} config is invalid`,
        detail: `${layer.path}: ${layer.error}`,
      });
    }
  }
  if (!loaded.layers.some((l) => l.error)) {
    const fileLoaded = await exists(configFilePath());
    add({
      id: "config",
      level: "ok",
      message: fileLoaded ? `Config loaded from ${configFilePath()}` : "Config: built-in defaults (no config.json yet)",
      detail: fileLoaded ? undefined : "Run `chatgpt-local-coder init` to write one.",
    });
  }

  for (const root of config.workspaceRoots) {
    add(
      (await exists(root))
        ? { id: `workspace:${root}`, level: "ok", message: `Workspace root ${root}` }
        : { id: `workspace:${root}`, level: "error", message: `Workspace root does not exist: ${root}` }
    );
  }

  add({
    id: "permissions",
    level: "ok",
    message: `Permission profile: ${config.permissionProfile}`,
    detail:
      config.permissionProfile === "open"
        ? "File tools are unrestricted. Approved shell commands always run with full host-user privileges regardless of profile."
        : "Approved shell commands run with full host-user privileges; scoping file tools does not sandbox a subshell.",
  });

  for (const [label, port] of [
    ["port", config.port],
    ["adminPort", config.adminPort],
  ] as const) {
    const host = label === "port" ? config.bindHost : "127.0.0.1";
    if (!(await portInUse(port, host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host))) {
      add({ id: label, level: "ok", message: `${label} ${port} is free` });
    } else if (await isOurServer(port, host)) {
      add({ id: label, level: "ok", message: `${label} ${port} is serving this host already` });
    } else {
      add({
        id: label,
        level: "warn",
        message: `${label} ${port} is held by another process`,
        detail: "Stop it or choose a different port before running `up`.",
      });
    }
  }

  const tunnel = await resolveTunnelBinary({ binPath: config.tunnel.binPath, download: false });
  add(
    tunnel.path
      ? {
          id: "tunnel",
          level: "ok",
          message: `tunnel-client found (${tunnel.source})`,
          detail: tunnel.path,
        }
      : {
          id: "tunnel",
          level: "warn",
          message: "tunnel-client is not installed",
          detail: "Run `chatgpt-local-coder tunnel init` to download it, or run with `up --no-tunnel`.",
        }
  );

  const delegates = detectDelegates(config.delegates.order);
  const available = delegates.filter((d) => d.available);
  if (!config.delegates.enabled) {
    add({ id: "delegates", level: "ok", message: "Delegates: disabled in config" });
  } else if (available.length) {
    add({
      id: "delegates",
      level: "ok",
      message: `Delegates: ${available.map((d) => d.id).join(", ")}`,
      detail: "Delegate CLIs are not sandboxed by this host's permission profile.",
    });
  } else {
    add({
      id: "delegates",
      level: "warn",
      message: "No delegate CLI on PATH",
      detail: `Looked for: ${delegates.map((d) => d.binary).join(", ")}. agent_delegate will refuse.`,
    });
  }

  // A fresh load rather than a cached one: doctor is asked precisely when the
  // user suspects the imported files are wrong.
  resetSettings();
  const settings = await loadSettings({
    workspaceRoots: config.workspaceRoots,
    sources: config.settings.sources,
    enabled: config.settings.import,
    host: { skillRoots: config.skills.roots },
  });
  const badSources = settings.sources.filter((s) => !s.ok);
  const okSources = settings.sources.filter((s) => s.ok);
  add({
    id: "settings",
    level: "ok",
    message: `Imported settings: ${okSources.length} file(s), ${settings.permissions.deny.length} deny rule(s) enforced`,
    detail: okSources.map((s) => s.path).join(", ") || undefined,
  });
  for (const bad of badSources) {
    add({ id: `settings:${bad.id}`, level: "warn", message: `Unreadable settings file`, detail: `${bad.path}: ${bad.error}` });
  }

  const registry = await loadSkillRegistry({
    workspaceRoots: config.workspaceRoots,
    extraRoots: [...settings.skillRoots, ...config.skills.roots],
    enabled: config.skills.enabled,
    disabled: config.skills.disabled,
  });
  add(
    registry.skills.length
      ? {
          id: "skills",
          level: "ok",
          message: `Skills: ${registry.skills.length} from ${registry.roots.length} root(s)`,
          detail: registry.shadowed.length ? `${registry.shadowed.length} shadowed by an earlier root` : undefined,
        }
      : {
          id: "skills",
          level: "warn",
          message: "No skills discovered",
          detail: `Searched: ${registry.roots.map((r) => r.path).join(", ") || "no roots"}`,
        }
  );

  const secrets = await listSecretNames(KNOWN_SECRETS);
  add({
    id: "secrets",
    level: "ok",
    message: secrets.map((s) => `${s.name}=${s.set ? `set (${s.source})` : "unset"}`).join(", "),
    detail: (await exists(secretsPath())) ? `Store: ${secretsPath()}` : "No secrets file yet.",
  });

  for (const runtime of ["node", "python3", "git"]) {
    const found = which(runtime);
    add(
      found
        ? { id: `tool:${runtime}`, level: "ok", message: `${runtime} found`, detail: found }
        : { id: `tool:${runtime}`, level: "warn", message: `${runtime} is not on PATH` }
    );
  }

  return {
    ok: !findings.some((f) => f.level === "error"),
    platform: `${platformId()} (${os.release()})`,
    arch: archId(),
    node: process.versions.node,
    paths: {
      config: configDir(),
      state: stateDir(),
      cache: cacheDir(),
      configFile: configFilePath(),
      secrets: secretsPath(),
    },
    findings,
  };
}

const SYMBOL: Record<FindingLevel, string> = { ok: "ok  ", warn: "WARN", error: "FAIL" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `chatgpt-local-coder doctor — ${report.platform} ${report.arch}, Node ${report.node}`,
    `config: ${report.paths.configFile}`,
    "",
  ];

  for (const finding of report.findings) {
    lines.push(`  ${SYMBOL[finding.level]}  ${finding.message}`);
    if (finding.detail) lines.push(`        ${finding.detail}`);
  }

  const errors = report.findings.filter((f) => f.level === "error").length;
  const warnings = report.findings.filter((f) => f.level === "warn").length;
  lines.push("", `${errors} error(s), ${warnings} warning(s)`);
  return lines.join("\n");
}

/** Absolute paths for the report header, exported for `config path`. */
export function reportPaths(): DoctorReport["paths"] {
  return {
    config: configDir(),
    state: stateDir(),
    cache: cacheDir(),
    configFile: configFilePath(),
    secrets: secretsPath(),
  };
}

export function defaultLogFile(): string {
  return path.join(stateDir(), "server.log");
}
