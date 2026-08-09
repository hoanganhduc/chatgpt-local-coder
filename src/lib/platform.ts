/**
 * Platform adapter — the single place that knows about OS differences.
 * Everything else in the codebase should be OS-agnostic.
 */

import { execFile, execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { StringDecoder } from "string_decoder";

export type PlatformId = "win32" | "darwin" | "linux";
export type ArchId = "amd64" | "arm64";

export interface ShellSpec {
  /** Executable to spawn. */
  command: string;
  /** Build argv for running a script string. */
  args: (script: string) => string[];
  /** Human label used in diagnostics. */
  label: string;
  /**
   * Which language the script is written in. `CLC_SHELL` unties this from the
   * platform — a `pwsh` on Linux and a `bash` on Windows are both reachable —
   * so a caller that builds a script rather than passing one through has to ask
   * the shell rather than assume from the OS.
   */
  kind: "posix" | "powershell";
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
function windowsCandidates(binary: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const parseExts = (raw: string): string[] =>
    raw
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  const fromEnv = parseExts(env.PATHEXT || "");
  const exts = fromEnv.length ? fromEnv : parseExts(".EXE;.CMD;.BAT");
  const appended = exts.map((ext) => binary + ext);

  return exts.includes(path.extname(binary).toLowerCase()) ? [binary, ...appended] : appended;
}

function onPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  // fs.constants.X_OK "has no effect on Windows (will behave like
  // fs.constants.F_OK)", so on Windows it is the extension list, not the access
  // check, that decides whether a match is executable.
  const candidates = isWindows() ? windowsCandidates(binary, env) : [binary];

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
export function which(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return onPath(binary, env);
}

/**
 * Find Git Bash on native Windows without accepting System32\bash.exe, which
 * is the WSL launcher and cannot execute a native `C:\...` skill entrypoint.
 *
 * Git for Windows normally exposes `git.exe` from `<root>\cmd` while keeping
 * Bash in `<root>\bin`. Installer registry metadata covers ordinary installs;
 * the real git.exe path covers portable installs. PATH itself is not changed.
 */
export function gitBashPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isWindows()) return undefined;

  const candidates: string[] = [];
  const addRoot = (root: string | undefined) => {
    if (!root) return;
    candidates.push(path.win32.join(root, "bin", "bash.exe"));
    candidates.push(path.win32.join(root, "usr", "bin", "bash.exe"));
  };

  // Git for Windows records its install root. Query it with the canonical
  // system reg.exe so mutable ProgramFiles-style variables cannot substitute a
  // Bash binary. A caller supplying an isolated environment intentionally gets
  // isolated discovery and skips the host registry.
  if (env === process.env) {
    let reg: string | undefined;
    try {
      reg = windowsSystemTool("reg.exe");
    } catch {
      /* PATH discovery below can still find portable Git */
    }
    if (reg) {
      for (const [key, view] of [
        ["HKLM\\SOFTWARE\\GitForWindows", "/reg:64"],
        ["HKLM\\SOFTWARE\\GitForWindows", "/reg:32"],
        ["HKCU\\SOFTWARE\\GitForWindows", ""],
      ]) {
        try {
          const args = ["query", key, "/v", "InstallPath", ...(view ? [view] : [])];
          const output = execFileSync(reg, args, {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          });
          addRoot(/^\s*InstallPath\s+REG_\S+\s+(.+?)\s*$/im.exec(output)?.[1]);
        } catch {
          /* this registry view has no Git installation */
        }
      }
    }
  }

  // Ask specifically for git.exe: accepting a git.cmd shim would let a batch
  // alias select an unrelated sibling bash.exe.
  const locatedGit = which("git.exe", env);
  const git = locatedGit && path.win32.basename(locatedGit).toLowerCase() === "git.exe" ? locatedGit : undefined;
  if (git) {
    const parent = path.win32.dirname(git);
    const parentName = path.win32.basename(parent).toLowerCase();
    if (parentName === "cmd" || parentName === "bin") addRoot(path.win32.dirname(parent));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = path.win32.normalize(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const resolved = fs.realpathSync.native(candidate);
      if (!fs.statSync(resolved).isFile()) continue;
      if (path.win32.basename(resolved).toLowerCase() !== "bash.exe") continue;
      return resolved;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

function posixShellArgs(script: string): string[] {
  return ["-lc", script];
}

function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * The shell every part of this host runs a command through — `run_command`,
 * `start_process`, hooks and post-edit checks alike. Selection order:
 *   1. CLC_SHELL override (absolute path or bare name)
 *   2. Windows: pwsh, else powershell
 *   3. macOS: $SHELL if zsh/bash/sh, else /bin/zsh
 *   4. Linux: $SHELL if bash/zsh/sh, else /bin/sh
 *
 * Skills are the exception, and deliberately: a skill declares the runtime it
 * needs, so one that says `bash` gets bash whatever this returns.
 */
export function defaultShell(): ShellSpec {
  const override = (process.env.CLC_SHELL || "").trim();
  if (override) {
    const isPowerShell = /pwsh|powershell/i.test(path.basename(override));
    return {
      command: override,
      args: isPowerShell ? powershellArgs : posixShellArgs,
      label: path.basename(override),
      kind: isPowerShell ? "powershell" : "posix",
    };
  }

  if (isWindows()) {
    const pwsh = onPath("pwsh");
    const command = pwsh || "powershell.exe";
    return { command, args: powershellArgs, label: pwsh ? "pwsh" : "powershell", kind: "powershell" };
  }

  const envShell = (process.env.SHELL || "").trim();
  const envBase = envShell ? path.basename(envShell) : "";
  const acceptable =
    platformId() === "darwin" ? ["zsh", "bash", "sh"] : ["bash", "zsh", "sh"];

  if (envShell && acceptable.includes(envBase)) {
    return { command: envShell, args: posixShellArgs, label: envBase, kind: "posix" };
  }

  const fallback = platformId() === "darwin" ? "/bin/zsh" : "/bin/sh";
  return { command: fallback, args: posixShellArgs, label: path.basename(fallback), kind: "posix" };
}

/** Spawn options that make a child killable as a whole process tree. */
export function detachedSpawnOptions(): { detached: boolean; windowsHide: boolean } {
  return { detached: !isWindows(), windowsHide: true };
}

/** Process groups this host has started and not yet seen exit. */
const liveChildren = new Set<number>();
let forwardingSignals = false;

/**
 * Pass an interrupt on to the children this host started.
 *
 * Detaching a child is what gives it a process group to kill, and it is equally
 * what takes it out of the terminal's foreground group — so a Ctrl+C that used
 * to reach it no longer does. Forwarding by hand is the other half of that
 * trade: without it, interrupting the CLI leaves whatever it was running alive
 * and reparented to init.
 *
 * Windows detaches nothing, so a console Ctrl+C still reaches the whole console
 * group there and none of this applies.
 */
function installSignalForwarding(): void {
  if (forwardingSignals || isWindows()) return;
  forwardingSignals = true;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      for (const pid of liveChildren) {
        try {
          process.kill(-pid, signal);
        } catch {
          /* already gone, or never became a group leader */
        }
      }
      // Listening for these at all suppresses Node's default of terminating on
      // them. Whatever else listens owns the shutdown; when nothing does, the
      // default has to be put back by hand or an interrupted CLI would forward
      // the signal and then carry on running.
      if (process.listenerCount(signal) === 1) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      }
    });
  }
}

/**
 * Record a spawned child for the duration of its life. Returns the function
 * that forgets it again, which every exit path must call — a pid left behind
 * here would eventually be signalled after the kernel had reused it.
 */
export function trackChild(pid: number | undefined): () => void {
  if (!pid) return () => undefined;
  installSignalForwarding();
  liveChildren.add(pid);
  return () => liveChildren.delete(pid);
}

/**
 * How hard to insist.
 *
 *   escalate — ask, then insist. What a timeout wants: the process has had its
 *              chance and the caller is not offering another one.
 *   graceful — ask once and stop there, for a caller that means "please stop"
 *              and will follow up itself if the answer is no.
 *   force    — no asking.
 */
export type KillMode = "escalate" | "graceful" | "force";

/**
 * Kill a process and everything it started. Never throws.
 *
 * Windows treats all three modes alike, and little is lost by it: there is no
 * signal a console process can decline, and `child.kill("SIGTERM")` there was
 * already a TerminateProcess. `taskkill` without `/F` only asks windows to
 * close, so a console child would refuse it and the caller would be told a stop
 * was sent that never landed.
 */
export async function killProcessTree(pid: number, mode: KillMode = "escalate"): Promise<void> {
  if (!pid || pid <= 0) return;

  if (isWindows()) {
    // Windows has no process groups to signal, so the tree is walked by
    // taskkill. Spawned by absolute path: this runs with whatever env the host
    // has, and a caller that narrowed PATH would otherwise get a silent ENOENT
    // here and a child that outlives its timeout.
    const failed = await new Promise<boolean>((resolve) => {
      execFile(windowsSystemTool("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], (error) =>
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

  // Negative pid targets the process group created by detached spawn. The
  // process alone is the fallback: a child spawned without `detached` never led
  // a group, and reaching only it is better than reaching nothing.
  const signal = (name: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      try {
        process.kill(pid, name);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (mode === "force") {
    signal("SIGKILL");
    return;
  }

  if (!signal("SIGTERM") || mode === "graceful") return;

  await new Promise((resolve) => setTimeout(resolve, 500));
  signal("SIGKILL");
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
  /**
   * Set when output passed the `maxOutputBytes` cap and the rest was dropped. A
   * reader that cannot tell a complete result from a clipped one draws
   * conclusions from output it does not have.
   */
  truncated?: boolean;
}

/**
 * A Windows `.cmd`/`.bat` target, which is the shape an npm-installed CLI takes
 * on Windows. Win32 drops trailing dots and spaces and ignores an NTFS stream
 * suffix when it resolves a path, so `claude.cmd. .` and `claude.cmd::$DATA`
 * name the same file as `claude.cmd` and all three have to count as one.
 */
export function isWindowsBatchTarget(command: string): boolean {
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
export function windowsSystemTool(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isWindows()) {
    // GLOBALROOT reaches the kernel's SystemRoot link without trusting mutable
    // SystemRoot/windir environment variables. Resolve it before spawning:
    // CreateProcess does not accept the GLOBALROOT alias itself as argv[0].
    const globalRoot = path.win32.join("\\\\?\\GLOBALROOT\\SystemRoot\\System32", name);
    const resolved = fs.realpathSync.native(globalRoot);
    if (!fs.statSync(resolved).isFile()) {
      throw new Error(`Windows system tool is not a regular file: ${resolved}`);
    }
    return resolved;
  }
  // Cross-platform dry runs still need a representable Windows plan. This path
  // is rendered only; a non-Windows host never executes it.
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", name);
}

/** Which cmd.exe to run. Batch quoting depends on the stock parser and switches,
 * so an environment-controlled ComSpec is never an executable selector. */
function comSpec(env: NodeJS.ProcessEnv): string {
  return windowsSystemTool("cmd.exe", env);
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
  if (!isWindowsBatchTarget(command)) return null;

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
 * How long the stdio pipes are given once the process itself is gone.
 *
 * `close` fires when the pipes end, not when the process does, and a command
 * that leaves something running hands that something the very pipe it was
 * given — so `close` can be minutes away or never come at all. Waiting for it
 * is what made a run unbounded: a launcher that daemonises and exits 0 has
 * nothing left to time out, and a descendant that calls `setsid` is outside the
 * group the timeout kills.
 *
 * Two seconds is far longer than a pipe with no other writer needs — it ends as
 * soon as the process does — and short enough that a leaked one is not a hang.
 */
const STDIO_DRAIN_MS = 2_000;

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
    /**
     * How much of each stream to keep, counted in UTF-16 code units — the unit
     * JavaScript's own `.length` reports — and not in bytes, whatever the name
     * says. The two agree on ASCII and part company everywhere else: a cap of
     * 1000 keeps 1000 CJK characters, which is 3000 bytes of UTF-8. Budget for
     * three times the number here when the output may be non-ASCII.
     *
     * The name is left as it is because it is the exported signature and
     * `git-run.ts` republishes it: renaming it would turn every call that still
     * passes the old key into a silently uncapped one, which is a worse failure
     * than a name that has to be read alongside this note. Code units are also
     * the quantity actually worth bounding, since what the cap protects against
     * is V8 refusing a string past its maximum length.
     */
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
            // Detached, so the child leads a process group and `killProcessTree`
            // can reach everything it started. Without it the timeout is not a
            // bound at all: this promise settles on `close`, which waits for the
            // stdio pipes, and a surviving descendant holds the inherited stdout
            // open for as long as it runs. No-op on Windows, where the tree is
            // walked by taskkill instead.
            ...detachedSpawnOptions(),
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

    const captured = { stdout: "", stderr: "" };
    const dropped = { stdout: false, stderr: false };
    // One decoder per stream, held across chunks. A chunk boundary falls
    // wherever the OS happened to stop, which for any non-ASCII output lands
    // mid-character sooner or later; decoding each chunk on its own turned the
    // two halves into a pair of U+FFFD and reported truncated:false while doing
    // it. The decoder holds the incomplete tail until the bytes that finish it
    // arrive. It is deliberately not flushed at the end: an unfinished
    // character there means the command truly stopped mid-sequence, and
    // dropping those bytes is better than inventing a replacement glyph.
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let timedOut = false;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const untrack = trackChild(child.pid);

    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid ?? 0);
    }, timeoutMs);

    /** What was kept, and a note where the rest used to be. */
    const bounded = (key: "stdout" | "stderr"): string => {
      const text = captured[key].trim();
      if (!dropped[key]) return text;
      return `${text}\n[output truncated at ${maxOutput} characters]`;
    };

    const finish = (exitCode: number | null, spawnFailed = false) => {
      if (settled) return;
      settled = true;
      untrack();
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({
        stdout: bounded("stdout"),
        stderr: bounded("stderr"),
        exitCode,
        timedOut,
        spawnFailed,
        truncated: dropped.stdout || dropped.stderr,
      });
    };

    if (opts.stdin !== undefined) {
      // A hook that never reads stdin makes the write fail with EPIPE; that is
      // the child's choice, not an error worth surfacing.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.stdin);
    }

    /**
     * Keep up to `maxOutput` code units and drop the rest, without ever
     * stopping reading: a stream left unread fills its pipe and blocks the
     * writer, so a command that printed too much would hang rather than be
     * truncated.
     *
     * The cap is applied inside a chunk and not only between chunks. A chunk is
     * however much the OS had ready, not a fixed size: Linux hands over 64KB at
     * a time and Windows will hand over megabytes, so refusing the *next* chunk
     * bounded nothing when the first one was already 3MB — which is exactly the
     * case the cap exists for, on the platform where it went unenforced.
     */
    const capture = (key: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = maxOutput - captured[key].length;
      if (room <= 0) {
        dropped[key] = true;
        return;
      }
      const text = decoders[key].write(chunk);
      if (text.length <= room) {
        captured[key] += text;
        return;
      }
      // Cutting at an arbitrary index can leave the first half of a character
      // behind, and half of one is not worth the byte it saves.
      const kept = text.slice(0, room);
      const last = kept.charCodeAt(kept.length - 1);
      captured[key] += last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept;
      dropped[key] = true;
    };

    child.stdout?.on("data", capture("stdout"));
    child.stderr?.on("data", capture("stderr"));
    child.on("error", (error) => {
      // POSIX reports a missing or non-executable target here rather than by
      // throwing from spawn, so this is the same "never started" outcome the
      // synchronous catch above handles.
      captured.stderr += (captured.stderr ? "\n" : "") + error.message;
      finish(null, true);
    });
    child.on("exit", (code) => {
      // The process this host started is gone, and its exit code is already
      // known. Only the pipes are still open, so what remains is a question of
      // how long to keep reading them — not of whether this run has an answer.
      drainTimer = setTimeout(() => {
        // Left open and merely unref'd rather than destroyed: closing the read
        // end hands whatever still holds the write end an EPIPE on its next
        // write, and a daemon a launcher deliberately left behind should not
        // die of the way this host stopped watching it. Unref'd so it cannot
        // keep this process alive, and still drained so it cannot fill and
        // block the writer either.
        for (const stream of [child.stdout, child.stderr]) {
          (stream as unknown as { unref?: () => void } | null)?.unref?.();
        }
        finish(code);
      }, STDIO_DRAIN_MS);
    });
    // The ordinary path: nothing else holds the pipes, so they end with the
    // process and the drain deadline above is cleared without ever firing.
    child.on("close", (code) => finish(code));
  });
}

export function homeDir(): string {
  return os.homedir();
}
