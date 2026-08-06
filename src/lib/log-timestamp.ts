/**
 * Timestamps on the server's console output.
 *
 * Under a service supervisor the log file is stdout redirected to disk, so
 * every line in it arrives from a bare `console` call somewhere in the tree —
 * the HTTP log, the activity log, session events, and the boot banner all take
 * different routes to the same file. Stamping at the console boundary is the
 * one place that covers all of them, and without it a crash cannot be lined up
 * against the requests that preceded it: the process exits, systemd records the
 * time, and nothing in the log says when anything happened.
 */

let installed = false;

/**
 * Prefix `console.log`/`warn`/`error` with an ISO timestamp. Idempotent, so a
 * second call from a re-imported module does not stack two prefixes per line.
 * Blank spacer lines are left alone; a lone timestamp is noise, not a record.
 */
export function installLogTimestamps(): void {
  if (installed) return;
  installed = true;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      if (args.length === 0 || args[0] === "") {
        original(...args);
        return;
      }
      original(new Date().toISOString(), ...args);
    };
  }
}
