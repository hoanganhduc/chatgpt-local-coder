/**
 * Per-OS config, state and cache directory discovery.
 * XDG on Linux, Application Support on macOS, APPDATA/LOCALAPPDATA on Windows.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { platformId } from "../lib/platform.js";

export const APP_NAME = "chatgpt-local-coder";

function appData(): string {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function localAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

export function configDir(): string {
  if (process.env.CLC_CONFIG_DIR) return path.resolve(process.env.CLC_CONFIG_DIR);

  switch (platformId()) {
    case "win32":
      return path.join(appData(), APP_NAME);
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        APP_NAME
      );
  }
}

export function stateDir(): string {
  if (process.env.CLC_STATE_DIR) return path.resolve(process.env.CLC_STATE_DIR);

  switch (platformId()) {
    case "win32":
      return path.join(localAppData(), APP_NAME, "state");
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", APP_NAME, "state");
    default:
      return path.join(
        process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
        APP_NAME
      );
  }
}

export function cacheDir(): string {
  if (process.env.CLC_CACHE_DIR) return path.resolve(process.env.CLC_CACHE_DIR);

  switch (platformId()) {
    case "win32":
      return path.join(localAppData(), APP_NAME, "cache");
    case "darwin":
      return path.join(os.homedir(), "Library", "Caches", APP_NAME);
    default:
      return path.join(
        process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
        APP_NAME
      );
  }
}

export function configFilePath(): string {
  return path.join(configDir(), "config.json");
}

export function projectConfigFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".chatgpt-local-coder.json");
}

/** Home directory for the ai-agents-skills install target. */
export function agentHomeDir(): string {
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
