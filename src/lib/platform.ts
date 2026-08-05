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

/**
 * Names to try for `binary` on Windows, in order. A name that already ends in a
 * PATHEXT extension is a complete executable name and must be tried as written;
 * PATHEXT is only ever appended, so "node.exe" is looked up as "node.exe" and
 * not as "node.exe.exe".
 */
function windowsCandidates(binary: string): string[] {
  const parseExts = (raw: string): string[] =>
    raw
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  const fromEnv = parseExts(process.env.PATHEXT || "");
  const exts = fromEnv.length ? fromEnv : parseExts(".EXE;.CMD;.BAT");
  const appended = exts.map((ext) => binary + ext);

  return exts.includes(path.extname(binary).toLowerCase()) ? [binary, ...appended] : appended;
}

function onPath(binary: string): string | undefined {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // fs.constants.X_OK "has no effect on Windows (will behave like
  // fs.constants.F_OK)", so on Windows it is the extension list, not the access
  // check, that decides whether a match is executable.
  const candidates = isWindows() ? windowsCandidates(binary) : [binary];

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
    // Windows has no process groups to signal, so the tree is walked by
    // taskkill. Spawned by absolute path: this runs with whatever env the host
    // has, and a caller that narrowed PATH would otherwise get a silent ENOENT
    // here and a child that outlives its timeout.
    const failed = await new Promise<boolean>((resolve) => {
      execFile(systemTool("taskkill.exe", process.env), ["/PID", String(pid), "/T", "/F"], (error) =>
        resolve(Boolean(error))
      );
    });
    // taskkill also reports failure for a pid that already exited, so the
    // fallback has to tolerate a process that is simply gone. It reaches only
    // the process itself, not its children, which is still better than the
    // nothing-at-all this used to do.
    if (failed) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone, or not ours to kill */
      }
    }
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
  /**
   * Set when the child never started, so a caller can tell that apart from a
   * child that ran and printed nothing. Both look like `exitCode: null` with an
   * empty stdout, and treating the first as the second is what let the Windows
   * batch defect report a delegation that never happened as a success.
   */
  spawnFailed?: boolean;
}

/**
 * A Windows `.cmd`/`.bat` target, which is the shape an npm-installed CLI takes
 * on Windows. Win32 drops trailing dots and spaces and ignores an NTFS stream
 * suffix when it resolves a path, so `claude.cmd. .` and `claude.cmd::$DATA`
 * name the same file as `claude.cmd` and all three have to count as one.
 */
function isBatchTarget(command: string): boolean {
  const name = command.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/^[A-Za-z]:/, "").split(":")[0] ?? "";
  const ext = /\.([a-zA-Z0-9]+)[\s.]*$/.exec(stem)?.[1]?.toLowerCase();
  return ext === "cmd" || ext === "bat";
}

/**
 * Quote one argv element for a batch file. Two parsers read the same text in
 * turn and both have to be satisfied:
 *
 *   cmd.exe — inside a double-quoted region `& | < > ( ) ^ ;` are ordinary
 *   characters. `%` is expanded in a phase that runs before quoting is
 *   considered at all, so quoting cannot contain it; `%%cd:~,%` is used
 *   instead, an empty substring of the always-defined `CD` that leaves exactly
 *   one literal `%` behind.
 *
 *   the child's own parser (`CommandLineToArgvW` and the C runtime) — inside a
 *   quoted argument `""` is one literal quote, and a run of backslashes is
 *   doubled only when a quote follows it.
 *
 * `""` is used for an embedded quote rather than `\"` precisely because it
 * leaves cmd.exe's quoting balanced: the pair opens and closes with nothing
 * between, so no character is ever exposed outside a quoted region. `\"` is the
 * encoding that made CVE-2024-24576 exploitable.
 */
function quoteForBatch(value: string): string {
  let quoted = '"';
  let backslashes = 0;

  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? backslashes * 2 : backslashes);
    backslashes = 0;
    quoted += char === '"' ? '""' : char === "%" ? "%%cd:~,%" : char;
  }

  // The run before the closing quote is doubled for the same reason: otherwise
  // a trailing backslash would escape that quote for the child's parser and
  // merge this element with the next one.
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/** CR and LF end a cmd.exe command wherever they appear, quoted or not, and
 * 0x1A ends its input. No quoting can carry them, so they are refused. */
const BATCH_UNREPRESENTABLE = /[\r\n\u001a]/;

/** cmd.exe truncates its command line at 8191 characters. */
const MAX_BATCH_COMMAND_LINE = 8000;

/**
 * Absolute path to a stock Windows tool.
 *
 * Never spawn one of these by bare name. libuv resolves a Windows child from
 * PATH alone — it does not fall back to the System32 lookup CreateProcess does
 * on its own — so a caller that narrows PATH makes the spawn fail with ENOENT.
 */
function systemTool(name: string, env: NodeJS.ProcessEnv): string {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", name);
}

/** Which cmd.exe to run. Only a real cmd.exe understands the switches and the
 * `%%cd:~,%` escape below, so a `ComSpec` naming anything else is ignored. */
function comSpec(env: NodeJS.ProcessEnv): string {
  const configured = (env.ComSpec || env.COMSPEC || "").trim();
  if (configured && path.win32.basename(configured).toLowerCase() === "cmd.exe") return configured;
  return systemTool("cmd.exe", env);
}

export interface BatchInvocation {
  /** cmd.exe, the only program that can run a batch file. */
  command: string;
  /** argv[0] as cmd.exe will read it back out of the verbatim command line. */
  argv0: string;
  /** `/d /e:on /v:off /s /c` plus the quoted command line. */
  args: string[];
}

/**
 * Build the cmd.exe invocation that runs a Windows `.bat`/`.cmd` target, or
 * null when `command` is not one.
 *
 *   /d      no AutoRun command from the registry runs first
 *   /e:on   command extensions on, which `%%cd:~,%` depends on
 *   /v:off  `!` is never delayed expansion, whatever the registry says
 *   /s      the outer quotes are stripped by position, not by inspection
 *
 * Exported so the encoding can be asserted from any OS; `runExecutable` reaches
 * for it only on Windows. Throws for an argument no cmd.exe command line can
 * carry, which `runExecutable` reports the same way it reports a failed spawn.
 */
export function windowsBatchInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): BatchInvocation | null {
  if (!isBatchTarget(command)) return null;

  const tokens = [command, ...args];
  const unrepresentable = tokens.find((token) => BATCH_UNREPRESENTABLE.test(token));
  if (unrepresentable !== undefined) {
    throw new Error(
      `${command} is a Windows batch file, and cmd.exe reads a newline in an argument as the start of a second command, so ${JSON.stringify(unrepresentable)} cannot be passed to it`
    );
  }

  const line = tokens.map(quoteForBatch).join(" ");
  if (line.length > MAX_BATCH_COMMAND_LINE) {
    throw new Error(
      `${command} is a Windows batch file, and the quoted command line is ${line.length} characters, past what cmd.exe accepts`
    );
  }

  const comspec = comSpec(env);
  return {
    command: comspec,
    // Verbatim mode joins argv exactly as written, so argv[0] carries its own
    // quotes; without them a ComSpec containing a space would split into two
    // tokens when cmd.exe re-reads its own command line.
    argv0: `"${comspec}"`,
    args: ["/d", "/e:on", "/v:off", "/s", "/c", `"${line}"`],
  };
}

/**
 * Run an executable directly (no shell). Used for probing CLIs and for
 * tunnel/service management where argv must not be re-parsed by a shell.
 *
 * A Windows `.bat`/`.cmd` target is the one thing this host cannot start
 * directly; it goes through cmd.exe with argv quoted for cmd.exe as well as for
 * the child, which keeps the guarantee every caller relies on — one argv
 * element in, one argv element out.
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
      // Windows cannot start a .bat/.cmd itself: since the CVE-2024-27980 fix
      // `spawn` answers one with EINVAL unless a shell is asked for, and
      // `shell: true` would hand the whole argv to cmd.exe as one unquoted
      // string. cmd.exe is therefore spawned explicitly with a command line
      // quoted here for both parsers that read it. A reader on Linux or macOS
      // never sees any of this: there an npm CLI is an ordinary executable and
      // argv reaches execve untouched.
      const batch = isWindows() ? windowsBatchInvocation(command, args, opts.env ?? process.env) : null;
      child = batch
        ? spawn(batch.command, batch.args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            windowsHide: true,
            argv0: batch.argv0,
            // The command line is already quoted; libuv must not quote it again.
            windowsVerbatimArguments: true,
          })
        : spawn(command, args, {
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
        spawnFailed: true,
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

    const finish = (exitCode: number | null, spawnFailed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode, timedOut, spawnFailed });
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
      // POSIX reports a missing or non-executable target here rather than by
      // throwing from spawn, so this is the same "never started" outcome the
      // synchronous catch above handles.
      stderr += (stderr ? "\n" : "") + error.message;
      finish(null, true);
    });
    child.on("close", (code) => finish(code));
  });
}

export function homeDir(): string {
  return os.homedir();
}
