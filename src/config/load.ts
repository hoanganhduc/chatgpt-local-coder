/**
 * Layered configuration.
 *
 * Precedence, lowest to highest:
 *   1. built-in defaults
 *   2. <configDir>/config.json
 *   3. <workspaceRoot>/.chatgpt-local-coder.json
 *   4. environment variables
 *   5. CLI flags
 */

import fs from "fs";
import path from "path";

import { isWindows } from "../lib/platform.js";
import { configFilePath, projectConfigFilePath, ensureDir, configDir } from "./paths.js";
import {
  hostConfigSchema,
  partialHostConfigSchema,
  type HostConfig,
  type PartialHostConfig,
} from "./schema.js";

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Split a path list. Always honours ";" so existing Windows-style values keep
 * working everywhere; additionally honours ":" on POSIX, without shredding
 * Windows drive paths that happen to appear there.
 */
export function splitPathList(value: string | undefined): string[] {
  if (!value) return [];

  const semicolonParts = value.split(";");
  const parts = isWindows()
    ? semicolonParts
    : semicolonParts.flatMap((part) => (WINDOWS_DRIVE.test(part.trim()) ? [part] : part.split(":")));

  return parts
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where `override` wins; arrays replace rather than concatenate. */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out as T;
}

export interface ConfigLayer {
  id: string;
  path?: string;
  values: PartialHostConfig;
  error?: string;
}

function readJsonLayer(id: string, filePath: string): ConfigLayer | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  try {
    const parsed = partialHostConfigSchema.parse(JSON.parse(raw));
    return { id, path: filePath, values: parsed };
  } catch (error) {
    return {
      id,
      path: filePath,
      values: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function envLayer(): ConfigLayer {
  const roots = [
    ...splitPathList(process.env.WORKSPACE_PATH),
    ...splitPathList(process.env.EXTRA_WORKSPACE_PATHS),
    ...splitPathList(process.env.WORKSPACE_PATHS),
    ...splitPathList(process.env.ALLOWED_WORKSPACE_PATHS),
  ];

  const values: PartialHostConfig = {};

  if (roots.length) values.workspaceRoots = roots;

  const profile = (process.env.CLC_PERMISSION_PROFILE || "").trim().toLowerCase();
  if (profile === "workspace" || profile === "open" || profile === "readonly") {
    values.permissionProfile = profile;
  }

  const bindHost = (process.env.CLC_BIND_HOST || process.env.MCP_BIND_HOST || "").trim();
  if (bindHost) values.bindHost = bindHost;

  const port = envNumber("PORT");
  if (port !== undefined) values.port = port;

  const adminPort = envNumber("ADMIN_PORT");
  if (adminPort !== undefined) values.adminPort = adminPort;

  const shellTimeout = envNumber("SHELL_TIMEOUT");
  if (shellTimeout !== undefined) values.shellTimeoutSec = shellTimeout;

  const toolProfile = (process.env.CHATGPT_TOOL_PROFILE || "").trim().toLowerCase();
  if (toolProfile === "full" || toolProfile === "slim") values.toolProfile = toolProfile;

  const skillRoots = splitPathList(process.env.CLC_SKILL_ROOTS);
  const allowExecution = envBool("CLC_SKILL_EXECUTION");
  const skills: NonNullable<PartialHostConfig["skills"]> = {};
  if (skillRoots.length) skills.roots = skillRoots;
  if (allowExecution !== undefined) skills.allowExecution = allowExecution;
  if (Object.keys(skills).length) values.skills = skills;

  const importSettings = envBool("CLC_SETTINGS_IMPORT");
  if (importSettings !== undefined) values.settings = { import: importSettings };

  const delegatesEnabled = envBool("CLC_DELEGATES");
  if (delegatesEnabled !== undefined) values.delegates = { enabled: delegatesEnabled };

  const hooksEnabled = envBool("CLC_HOOKS");
  if (hooksEnabled !== undefined) values.hooks = { enabled: hooksEnabled };

  const tunnelAlias = (process.env.CLC_TUNNEL_ALIAS || "").trim();
  const tunnelBin = (process.env.CLC_TUNNEL_BIN || "").trim();
  const tunnel: NonNullable<PartialHostConfig["tunnel"]> = {};
  if (tunnelAlias) tunnel.alias = tunnelAlias;
  if (tunnelBin) tunnel.binPath = tunnelBin;
  if (Object.keys(tunnel).length) values.tunnel = tunnel;

  return { id: "env", values };
}

export interface LoadedConfig {
  config: HostConfig;
  layers: ConfigLayer[];
  configFile: string;
}

export interface LoadConfigOptions {
  /** Highest-precedence layer, normally parsed CLI flags. */
  overrides?: PartialHostConfig;
  /** Skip reading environment variables — used by tests. */
  skipEnv?: boolean;
  /** Explicit cwd for locating the project config file. */
  cwd?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const layers: ConfigLayer[] = [];

  const userLayer = readJsonLayer("user", configFilePath());
  if (userLayer) layers.push(userLayer);

  // The project file is anchored on the deployment-time root — CLI flags first,
  // then WORKSPACE_PATH — falling back to cwd. The user config's roots are
  // deliberately excluded: they are a global default, and letting them move the
  // anchor would make a project file in the current directory disappear as soon
  // as the user config named any root at all.
  const preliminaryRoots = [
    ...(opts.overrides?.workspaceRoots ?? []),
    ...(opts.skipEnv ? [] : splitPathList(process.env.WORKSPACE_PATH)),
  ];
  const projectRoot = preliminaryRoots[0] ? path.resolve(preliminaryRoots[0]) : cwd;

  const projectLayer = readJsonLayer("project", projectConfigFilePath(projectRoot));
  if (projectLayer) layers.push(projectLayer);

  if (!opts.skipEnv) layers.push(envLayer());
  if (opts.overrides) layers.push({ id: "flags", values: opts.overrides });

  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer.values as Record<string, unknown>);
  }

  const parsed = hostConfigSchema.parse(merged);

  const roots = (parsed.workspaceRoots.length ? parsed.workspaceRoots : [cwd]).map((root) =>
    path.resolve(root)
  );
  parsed.workspaceRoots = [...new Set(roots)];

  return { config: parsed, layers, configFile: configFilePath() };
}

export function writeUserConfig(values: PartialHostConfig): string {
  ensureDir(configDir());
  const target = configFilePath();

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(target, "utf-8"));
  } catch {
    existing = {};
  }

  const merged = deepMerge(existing, values as Record<string, unknown>);
  fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  return target;
}
