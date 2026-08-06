/**
 * The one place a git subprocess is started.
 *
 * Both callers — the git tools and the session-start snapshot — used to spawn
 * git themselves and append every chunk it printed to a string with no ceiling.
 * That is the shape that ended the server from `run_command`: a JavaScript
 * string has a maximum length, the append that crosses it throws, and it throws
 * inside a stream listener where nothing catches it. Having written it twice is
 * the argument for writing it once.
 *
 * Running through `runExecutable` gives git the bounds the rest of this host
 * already has: output is capped, the run has a deadline, and stdin is closed
 * rather than left open on a pipe nobody writes to.
 */

import { runExecutable } from "./platform.js";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** The deadline was reached and git was killed. `exit_code` means nothing then. */
  timed_out: boolean;
  /** No git on PATH at all, which is not the same as a git that ran and failed. */
  not_found: boolean;
}

/**
 * How long a git subcommand may take.
 *
 * Generous, because `git commit` runs the repository's own pre-commit hooks and
 * a hook that runs a test suite is slow rather than stuck. This bounds a hang;
 * it does not police slow work.
 */
export const GIT_TIMEOUT_MS = 120_000;

export async function runGit(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const result = await runExecutable("git", args, {
    cwd,
    timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    // Closed at once, as every other spawn in this host closes it. Not a fix
    // for anything git does today — it runs its own hooks with stdin already
    // redirected from /dev/null, so none of the subcommands reached from here
    // waits on it. It is the pipe itself that is the hazard: spawning hands the
    // child one that nobody ever writes to, and any subcommand added later that
    // reads stdin would wait on it for the whole deadline below.
    stdin: "",
  });

  return {
    stdout: result.stdout,
    // A killed git has usually said nothing about why it stopped, and "git
    // exited with code 1" is not what happened.
    stderr: result.timedOut ? `git ${args[0] ?? ""} timed out after ${timeoutMs / 1000}s` : result.stderr,
    // A process killed by a signal reports no exit code at all on POSIX.
    // Reporting that as 0 would read as success.
    exit_code: result.exitCode ?? 1,
    timed_out: result.timedOut,
    not_found: result.spawnFailed === true,
  };
}
