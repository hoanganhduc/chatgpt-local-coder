/**
 * Platform adapter — the single place that knows about OS differences.
 * Everything else in the codebase should be OS-agnostic.
 */

import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export type PlatformId = "win32" | "darwin" | "linux";
export type ArchId = "amd64" | "arm64";

export interface ShellSpec {
  /** Executable to spawn. */
  command: string;
  /** Build argv for running a script string. */
  args: (script: string) => string[];
  /** Human label used in diagnostics. */
  label: string;
}

export function platformId(): PlatformId {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export function isWindows(): boolean {
  return platformId() === "win32";
}

export function archId(): ArchId {
  return process.arch === "arm64" || process.arch === "arm" ? "arm64" : "amd64";
}

export function exeSuffix(): string {
  return isWindows() ? ".exe" : "";
}

/** Case-insensitive path comparison on Windows and macOS. */
export function pathsAreCaseInsensitive(): boolean {
  return platformId() !== "linux";
}

function onPath(binary: string): string | undefined {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const candidates = isWindows()
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((ext) => binary + ext.toLowerCase())
    : [binary];

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

/** Look up an executable on PATH; returns the absolute path or undefined. */
export function which(binary: string): string | undefined {
  return onPath(binary);
}

function posixShellArgs(script: string): string[] {
  return ["-lc", script];
}

function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Shell selection order:
 *   1. CLC_SHELL override (absolute path or bare name)
 *   2. Windows: pwsh, else powershell
 *   3. macOS: $SHELL if zsh/bash/sh, else /bin/zsh
 *   4. Linux: $SHELL if bash/zsh/sh, else /bin/sh
 */
export function defaultShell(): ShellSpec {
  const override = (process.env.CLC_SHELL || "").trim();
  if (override) {
    const isPowerShell = /pwsh|powershell/i.test(path.basename(override));
    return {
      command: override,
      args: isPowerShell ? powershellArgs : posixShellArgs,
      label: path.basename(override),
    };
  }

  if (isWindows()) {
    const pwsh = onPath("pwsh");
    const command = pwsh || "powershell.exe";
    return { command, args: powershellArgs, label: pwsh ? "pwsh" : "powershell" };
  }

  const envShell = (process.env.SHELL || "").trim();
  const envBase = envShell ? path.basename(envShell) : "";
  const acceptable =
    platformId() === "darwin" ? ["zsh", "bash", "sh"] : ["bash", "zsh", "sh"];

  if (envShell && acceptable.includes(envBase)) {
    return { command: envShell, args: posixShellArgs, label: envBase };
  }

  const fallback = platformId() === "darwin" ? "/bin/zsh" : "/bin/sh";
  return { command: fallback, args: posixShellArgs, label: path.basename(fallback) };
}

/** Spawn options that make a child killable as a whole process tree. */
export function detachedSpawnOptions(): { detached: boolean; windowsHide: boolean } {
  return { detached: !isWindows(), windowsHide: true };
}

/** Kill a process and everything it started. Never throws. */
export async function killProcessTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;

  if (isWindows()) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    });
    return;
  }

  try {
    // Negative pid targets the process group created by detached spawn.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run an executable directly (no shell). Used for probing CLIs and for
 * tunnel/service management where argv must not be re-parsed by a shell.
 */
export function runExecutable(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    /** Written to the child's stdin, which is then closed. */
    stdin?: string;
  } = {}
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOutput = opts.maxOutputBytes ?? 2_000_000;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid ?? 0);
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode, timedOut });
    };

    if (opts.stdin !== undefined) {
      // A hook that never reads stdin makes the write fail with EPIPE; that is
      // the child's choice, not an error worth surfacing.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.stdin);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxOutput) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += (stderr ? "\n" : "") + error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export function homeDir(): string {
  return os.homedir();
}
