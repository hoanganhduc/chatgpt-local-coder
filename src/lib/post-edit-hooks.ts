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
import { requireCommandAllowed } from "./permissions.js";
import { detachedSpawnOptions, killProcessTree, trackChild } from "./platform.js";

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

/**
 * The name the edited path is passed under. The path is handed to the shell as
 * an environment variable and `{path}` expands to a *reference* to it, so the
 * path itself is never part of the command text.
 *
 * This is what keeps a filename from becoming code. Neither a POSIX shell nor
 * PowerShell re-scans the result of a parameter expansion for metacharacters,
 * so a file named `inj$(touch owned).ts` expands to that literal string instead
 * of running anything — in the bare and the double-quoted form alike. Quoting
 * the path into the command text cannot achieve the same thing: the shipped
 * config writes `"{path}"`, and no escaping is correct for both a quoted and an
 * unquoted template.
 *
 * The one behavioural cost is that a template using the bare form (`lint
 * {path}`) word-splits a path containing spaces, where `"{path}"` does not.
 */
const HOOK_PATH_VAR = "CLC_HOOK_PATH";

/** How much of a check's output is held while it runs. The report keeps 2000. */
const MAX_HOOK_OUTPUT = 100_000;

function runHook(
  command: string,
  filePath: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exit_code: number | null; error?: string }> {
  const isWindows = process.platform === "win32";
  const reference = isWindows ? `$env:${HOOK_PATH_VAR}` : `$${HOOK_PATH_VAR}`;
  const expanded = command.replace(/\{path\}/g, reference).replace(/\{file\}/g, reference);

  try {
    // The same gate `runCommandHook` applies in the hooks engine. Without it a
    // model holding only `write_file` runs, on every edit, a command that
    // `run_command` would refuse — so an imported deny rule would hold at the
    // front door and not here. Checked against the expanded text because that
    // is what reaches the shell.
    requireCommandAllowed(expanded);
  } catch (error) {
    // A refused check has not run, so it has not judged the file. Reported the
    // way the engine reports one, rather than as a failure of the edit.
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exit_code: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const shell = isWindows ? "powershell.exe" : "bash";
  const args = isWindows ? ["-NoProfile", "-Command", expanded] : ["-lc", expanded];

  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd: path.dirname(filePath),
      env: { ...process.env, [HOOK_PATH_VAR]: filePath },
      // Detached, so the kill below reaches the whole tree and not just the
      // shell that leads it.
      ...detachedSpawnOptions(),
    });
    const untrack = trackChild(child.pid);
    let stdout = "";
    let stderr = "";

    // Close stdin at once. Spawning gives the child a pipe nobody here ever
    // writes to, so a hook that reads stdin at all blocks on it until its
    // timeout — which is how `echo checked <path>` intermittently took the full
    // 10s under PowerShell on CI and returned nothing. Every other spawn in
    // this host already ends stdin; this one did not. A hook that ignores stdin
    // sees the same EOF a closed handle would have given it.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // The whole tree, not just the shell: a surviving grandchild keeps
      // `cwd` open, and on Windows that is enough to make a later rmdir of
      // that directory fail with EBUSY. Settled only once the kill is done, so
      // returning means the handle is gone rather than merely signalled.
      void killProcessTree(child.pid ?? 0).then(() => {
        untrack();
        resolve({ stdout, stderr: stderr || "hook timeout", exit_code: null });
      });
    }, timeoutMs);

    // Bounded well above the 2000 characters the report keeps, and far below
    // what a string can hold: a checker that prints without limit would
    // otherwise be appended to until the append itself threw, inside a stream
    // listener where nothing catches it. Still read after the cap, since a
    // stream left unread fills its pipe and blocks the checker on it.
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_HOOK_OUTPUT) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_HOOK_OUTPUT) stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The kill itself closes the child, and that fires here first. Reporting
      // it would describe a timed-out check as an ordinary one killed by a
      // signal — the same "hook timeout" marker the caller reads, dropped — so
      // the timeout path is left to settle instead.
      if (timedOut) return;
      untrack();
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      untrack();
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
        ...(out.error ? { error: out.error } : {}),
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