/**
 * Post-edit checks — syntax linters run against files a tool just wrote.
 *
 * These are configured separately from imported settings hooks (see
 * `profiles/post-edit-hooks.json`) because they match on file globs rather than
 * tool names. They reach tool dispatch by registering themselves as an internal
 * `PostToolUse` hook, so there is one path through which anything runs after a
 * tool call.
 */

import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { registerInternalHook } from "../hooks/engine.js";

export interface PostEditHook {
  glob: string;
  command: string;
  timeout_ms?: number;
}

interface HooksConfig {
  enabled?: boolean;
  hooks?: PostEditHook[];
}

const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../profiles/post-edit-hooks.json"
);

function globMatch(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(filename.replace(/\\/g, "/"));
}

async function loadHooksConfig(): Promise<HooksConfig> {
  const configPath = process.env.POST_EDIT_HOOKS_CONFIG || DEFAULT_CONFIG_PATH;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw) as HooksConfig;
  } catch {
    return { enabled: false, hooks: [] };
  }
}

function runHook(command: string, filePath: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exit_code: number | null }> {
  const expanded = command.replace(/\{path\}/g, filePath).replace(/\{file\}/g, filePath);
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", expanded] : ["-lc", expanded];

  return new Promise((resolve) => {
    const child = spawn(shell, args, { cwd: path.dirname(filePath), windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr: stderr || "hook timeout", exit_code: null });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: "hook spawn failed", exit_code: 1 });
    });
  });
}

export async function runPostEditHooks(filePaths: string[]): Promise<Record<string, unknown> | undefined> {
  const config = await loadHooksConfig();
  if (config.enabled === false || !config.hooks?.length) return undefined;

  const results: Array<Record<string, unknown>> = [];

  for (const filePath of filePaths) {
    const base = path.basename(filePath);
    const rel = filePath.replace(/\\/g, "/");
    for (const hook of config.hooks) {
      if (!globMatch(base, hook.glob) && !globMatch(rel, hook.glob)) continue;
      const out = await runHook(hook.command, filePath, hook.timeout_ms ?? 15000);
      results.push({
        file: filePath,
        glob: hook.glob,
        command: hook.command,
        exit_code: out.exit_code,
        stdout: out.stdout.slice(0, 2000),
        stderr: out.stderr.slice(0, 2000),
      });
    }
  }

  if (!results.length) return undefined;
  return { post_edit_hooks: results };
}

/** Tools whose result names files that were just written. */
const EDIT_TOOLS = [
  "write_file",
  "write_file_base64",
  "edit_file",
  "multi_edit",
  "replace_regex",
  "apply_patch",
  "move_file",
  "copy_file",
].join("|");

/**
 * Pull written paths out of a tool result. Single-file tools report `path`;
 * multi-file `apply_patch` reports a `files` array whose failed entries are
 * skipped, since nothing was written for those.
 */
function editedPaths(result: unknown): string[] {
  const data = (result as { structuredContent?: { data?: Record<string, unknown> } })?.structuredContent?.data;
  if (!data || data.dry_run === true) return [];

  const paths: string[] = [];
  if (typeof data.path === "string") paths.push(data.path);
  if (Array.isArray(data.files)) {
    for (const entry of data.files) {
      const file = entry as { ok?: boolean; path?: unknown };
      if (file?.ok !== false && typeof file?.path === "string") paths.push(file.path);
    }
  }
  return paths;
}

export function registerPostEditHook(): void {
  registerInternalHook("PostToolUse", {
    name: "post-edit-checks",
    matcher: EDIT_TOOLS,
    run: async (ctx) => {
      const paths = editedPaths(ctx.result);
      if (!paths.length) return undefined;
      const hooks = await runPostEditHooks(paths);
      return hooks ? { enrich: hooks } : undefined;
    },
  });
}