/**
 * Permission profiles.
 *
 * | Profile     | Read     | Write                  | Commands |
 * |-------------|----------|------------------------|----------|
 * | workspace   | anywhere | workspace roots only   | allowed  |
 * | open        | anywhere | anywhere               | allowed  |
 * | readonly    | anywhere | denied                 | denied   |
 *
 * "anywhere" excludes this host's own config directory in every profile — see
 * `isProtectedPath`.
 *
 * `workspace` is the default. Note the deliberate boundary: file tools are
 * scoped, but an approved shell command runs with full host-user privileges.
 * Scoping file tools does not sandbox `npm`, `python` or a subshell.
 */

import fs from "fs";
import path from "path";

import { configDir } from "../config/paths.js";
import { pathsAreCaseInsensitive } from "./platform.js";

export type PermissionProfile = "workspace" | "open" | "readonly";
export type PathIntent = "read" | "write";

interface PermissionContext {
  profile: PermissionProfile;
  roots: string[];
}

let context: PermissionContext = {
  profile: "workspace",
  roots: [process.cwd()],
};

/**
 * Deny rules imported from another agent's settings. The checker is injected
 * rather than imported so this low-level module stays free of any dependency on
 * the settings layer above it.
 *
 * Only `deny` is enforced here. An imported `allow` never widens the profile —
 * see `src/settings/merge.ts` for why that asymmetry is deliberate.
 */
export type ImportedRuleCheck = (
  tool: string,
  argument: string
) => { decision: "deny" | "ask"; rule: string } | null;

let importedRuleCheck: ImportedRuleCheck | null = null;

export function setImportedRuleCheck(check: ImportedRuleCheck | null): void {
  importedRuleCheck = check;
}

function enforceImportedDeny(tool: string, argument: string): void {
  const verdict = importedRuleCheck?.(tool, argument);
  if (verdict?.decision !== "deny") return;
  throw new Error(
    [
      `Permission denied by an imported rule: ${verdict.rule}`,
      `  tool:  ${tool}`,
      `  input: ${argument}`,
      `Fix: remove the rule from the source settings file, or disable import with settings.import = false.`,
    ].join("\n")
  );
}

export function setPermissionContext(next: { profile: PermissionProfile; roots: string[] }): void {
  context = {
    profile: next.profile,
    roots: [...new Set(next.roots.map((root) => path.resolve(root)))],
  };
}

export function getPermissionProfile(): PermissionProfile {
  return context.profile;
}

export function getWorkspaceRoots(): string[] {
  return [...context.roots];
}

export function isReadOnly(): boolean {
  return context.profile === "readonly";
}

export function canWriteFiles(): boolean {
  return context.profile !== "readonly";
}

export function canRunCommands(): boolean {
  return context.profile !== "readonly";
}

export function canUseAnyAbsolutePath(): boolean {
  return context.profile === "open";
}

function normalizeForCompare(target: string): string {
  const resolved = path.resolve(target);
  return pathsAreCaseInsensitive() ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve symlinks as far as the path exists, so a link that points outside a
 * workspace root cannot be used to escape it. Non-existent leaf segments (the
 * normal case when creating a file) are appended back onto the real ancestor.
 */
export function resolveRealPath(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];

  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }

  return path.resolve(target);
}

function isInsideRoot(resolved: string, root: string): boolean {
  const a = normalizeForCompare(resolved);
  const b = normalizeForCompare(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Paths no profile reaches, in either direction.
 *
 * The host's own config directory holds `secrets.json` and the `secret-refs/`
 * files the tunnel runtime is started with, so a tool able to read it would let
 * a connected model print the key that authorizes the tunnel back over that same
 * tunnel. `open` is deliberately not an exemption: it widens the workspace
 * boundary, which is a statement about the user's own files, not permission to
 * read the credentials this process holds on their behalf.
 *
 * Read at call time rather than cached, so a test or a relocated install that
 * moves CLC_CONFIG_DIR is protected at its new location rather than its old one.
 */
export function isProtectedPath(target: string): boolean {
  const resolved = resolveRealPath(target);
  return isInsideRoot(resolved, resolveRealPath(configDir()));
}

export function isPathAllowed(target: string, intent: PathIntent): boolean {
  if (isProtectedPath(target)) return false;
  if (context.profile === "open") return true;
  if (intent === "read") return true;
  if (context.profile === "readonly") return false;

  const resolved = resolveRealPath(target);
  return context.roots.some((root) => isInsideRoot(resolved, resolveRealPath(root)));
}

export function describePermissionProfile(): string {
  switch (context.profile) {
    case "open":
      return "open: any path, any command — no workspace boundary";
    case "readonly":
      return "readonly: reads only — writes and commands are denied";
    default:
      return `workspace: writes confined to ${context.roots.join(", ")}; reads unrestricted apart from the host's own config directory; approved commands run as the host user`;
  }
}

function denialMessage(target: string, intent: PathIntent): string {
  if (isProtectedPath(target)) {
    return [
      `Permission denied: ${resolveRealPath(target)} is inside this host's own config directory.`,
      `It holds the credentials the host runs with, so no permission profile exposes it.`,
      `Fix: use the "clc secrets" command, which reports whether a key is set without printing it.`,
    ].join("\n");
  }

  if (context.profile === "readonly") {
    return `Permission denied: profile "readonly" forbids ${intent} operations. Set permissionProfile to "workspace" or "open" to allow writes.`;
  }

  return [
    `Permission denied: ${intent} outside workspace roots.`,
    `  path:    ${resolveRealPath(target)}`,
    `  profile: workspace`,
    `  roots:   ${context.roots.join(", ")}`,
    `Fix: add the path to workspaceRoots, or set permissionProfile to "open".`,
  ].join("\n");
}

export function requirePathAllowed(target: string, intent: PathIntent): void {
  // Imported deny rules are checked first: they apply regardless of profile, so
  // an `Edit(/**/.env)` rule blocks the write even inside a workspace root.
  enforceImportedDeny(intent === "write" ? "write_file" : "read_text_file", resolveRealPath(target));
  if (isPathAllowed(target, intent)) return;
  throw new Error(denialMessage(target, intent));
}

export function requireWriteAllowed(target?: string): void {
  if (!canWriteFiles()) {
    throw new Error(
      'Permission denied: profile "readonly" forbids writes. Set permissionProfile to "workspace" or "open".'
    );
  }
  if (target) requirePathAllowed(target, "write");
}

export function requireCommandAllowed(command: string): void {
  enforceImportedDeny("run_command", command);
  if (canRunCommands()) return;
  throw new Error(
    'Permission denied: profile "readonly" forbids running commands. Set permissionProfile to "workspace" or "open".'
  );
}

/**
 * Commands are never path-filtered — a shell can reach anything the host user
 * can. This is reported honestly rather than implied away.
 */
export function commandsAreSandboxed(): boolean {
  return false;
}

export function shouldBlockCommand(_command: string): boolean {
  return !canRunCommands();
}
