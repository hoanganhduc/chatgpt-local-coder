import fs from "fs";
import path from "path";
import os from "os";

import {
  getPermissionProfile,
  getWorkspaceRoots,
  requirePathAllowed,
  resolveRealPath,
  type PathIntent,
} from "./permissions.js";

let defaultCwd = process.cwd();

export function setDefaultCwd(cwd: string): void {
  defaultCwd = path.resolve(cwd);
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** @deprecated use setPermissionContext — kept for compatibility */
export function setAllowedRoots(roots: string[]): void {
  if (roots.length > 0) setDefaultCwd(roots[0]);
}

export function getAllowedRoots(): string[] {
  return getWorkspaceRoots();
}

export function setFullDiskAccess(_enabled: boolean): void {}

export function getFullDiskAccess(): boolean {
  return getPermissionProfile() === "open";
}

/**
 * Resolve a caller-supplied path and enforce the permission profile.
 *
 * `intent` is required so the boundary cannot be bypassed by forgetting it:
 * readers pass "read", every write-capable tool passes "write".
 */
export async function validatePath(inputPath: string, intent: PathIntent): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);

  requirePathAllowed(resolved, intent);
  return resolved;
}

/** Synchronous variant for code paths that cannot await. */
export function validatePathSync(inputPath: string, intent: PathIntent): string {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);

  requirePathAllowed(resolved, intent);
  return resolved;
}

export { resolveRealPath };

export function getMachineRoots(): string[] {
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        fs.accessSync(`${letter}:\\`, fs.constants.R_OK);
        drives.push(`${letter}:\\`);
      } catch {}
    }
    return drives.length ? drives : ["C:\\"];
  }
  return ["/", os.homedir()];
}
