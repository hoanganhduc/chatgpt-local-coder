import path from "path";
import { defaultShell, runExecutable } from "./platform.js";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  /** Set when the command printed more than the host will hold. */
  truncated?: boolean;
}

import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";

let sessionCwd: string | null = null;
let sessionInitializedAt: string | null = null;
let persistenceRoot: string | null = null;
const history: string[] = [];
const MAX_HISTORY = 50;

export function setShellPersistenceRoot(workspaceRoot: string): void {
  persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
}

/** Restore cwd from disk (ChatGPT = new MCP session per tool call). */
export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  setShellPersistenceRoot(defaultCwd);
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd);
  if (saved?.cwd) {
    sessionCwd = path.resolve(saved.cwd);
    sessionInitializedAt = saved.updated_at;
    if (saved.recent_commands?.length) {
      history.length = 0;
      history.push(...saved.recent_commands.slice(-MAX_HISTORY));
    }
    return;
  }
  initShellSession(defaultCwd);
}

export function getShellCwd(): string {
  if (!sessionCwd) throw new Error("Shell session not initialized");
  return sessionCwd;
}

export function resetShellSession(cwd: string): void {
  sessionCwd = path.resolve(cwd);
  sessionInitializedAt = new Date().toISOString();
  if (persistenceRoot) {
    void saveGlobalShellState(persistenceRoot, sessionCwd, undefined, null);
  }
}

export function getShellStatus() {
  return {
    active: sessionCwd !== null,
    cwd: sessionCwd,
    started_at: sessionInitializedAt,
    recent_commands: [...history].slice(-10),
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Cập nhật cwd khi gặp cd / Set-Location ở đầu command (giống Bash persistent). */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd" };
}

/**
 * Run one command through a shell.
 *
 * The spawn goes through `runExecutable` rather than being written out again
 * here, which is what gives this tool the bounds the rest of the host already
 * had. Three of them matter: output is capped, where this used to append every
 * byte a command produced until the string passed V8's maximum length and the
 * append threw inside a stream listener, ending the server; the run settles when
 * the shell exits rather than when its pipes close, where `run_command "npm run
 * dev &"` used to leave the call pending for as long as the background process
 * lived; and a timeout now kills the whole process tree instead of the shell
 * that leads it.
 */
async function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  const shell = defaultShell();

  // Closed at once. Spawning gives the child a pipe nobody here ever writes to,
  // so a command that reads stdin waits on it for the whole timeout instead of
  // seeing the EOF a non-interactive shell should give it.
  const result = await runExecutable(shell.command, shell.args(command), { cwd, timeoutMs, stdin: "" });

  if (result.spawnFailed) throw new Error(result.stderr || `failed to start ${shell.command}`);
  if (result.timedOut) throw new Error(`Command timed out after ${timeoutMs / 1000}s`);

  return {
    command,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    timed_out: false,
    truncated: result.truncated,
  };
}

export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  if (!sessionCwd) initShellSession(defaultCwd);

  if (workingDirectory) {
    sessionCwd = path.resolve(await Promise.resolve(workingDirectory));
  }

  const { cwd, command: effective } = applyCwdDirectives(sessionCwd!, command);
  sessionCwd = cwd;

  history.push(effective);
  if (history.length > MAX_HISTORY) history.shift();

  const result = await runOnce(effective, cwd, timeoutMs);
  sessionCwd = cwd;

  if (persistenceRoot) {
    const prev = await loadGlobalShellState(persistenceRoot, defaultCwd);
    await saveGlobalShellState(persistenceRoot, cwd, effective, prev);
  }

  return result;
}