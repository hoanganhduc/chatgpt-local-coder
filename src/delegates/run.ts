/**
 * Running a delegate CLI.
 *
 * The prompt is passed as an argv element, never interpolated into a shell
 * string, so a prompt containing quotes or `;` cannot become extra shell words.
 *
 * Nothing here sandboxes the delegate. The permission profile is consulted for
 * two things only: whether this host may run commands at all, and whether `cwd`
 * is a directory this host is allowed to work in.
 */

import { runExecutable } from "../lib/platform.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { validatePath } from "../lib/path-security.js";
import {
  getDelegateSpec,
  isDelegateId,
  orderDelegates,
  probeDelegates,
  type DelegateId,
  type DetectedDelegate,
} from "./registry.js";

/** Captured output ceiling. A delegate transcript can be arbitrarily long. */
export const MAX_DELEGATE_OUTPUT_BYTES = 200 * 1024;

export interface DelegateRunOptions {
  prompt: string;
  /** Force a specific CLI; otherwise the first available one in `order` wins. */
  agent?: string;
  cwd?: string;
  timeoutSec?: number;
  /** From `delegates.order`. */
  order?: string[];
  /** From `delegates.enabled`. */
  enabled?: boolean;
}

export interface DelegateRunSuccess {
  ok: true;
  delegate: DelegateId;
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  output: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface DelegateRunFailure {
  ok: false;
  error: string;
  probed: DetectedDelegate[];
}

export type DelegateRunResult = DelegateRunSuccess | DelegateRunFailure;

function cap(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_DELEGATE_OUTPUT_BYTES) return { text, truncated: false };
  const clipped = Buffer.from(text).subarray(0, MAX_DELEGATE_OUTPUT_BYTES).toString();
  return { text: clipped, truncated: true };
}

function describeProbe(entries: DetectedDelegate[]): string {
  return entries.map((e) => `${e.binary} (${e.available ? "found" : "not on PATH"})`).join(", ");
}

export async function runDelegate(opts: DelegateRunOptions): Promise<DelegateRunResult> {
  const order = orderDelegates(opts.order);
  const entries = await probeDelegates(opts.order);

  if (opts.enabled === false) {
    return {
      ok: false,
      error: "Delegation is disabled — set delegates.enabled = true to allow it.",
      probed: entries,
    };
  }

  if (opts.agent && !isDelegateId(opts.agent)) {
    return {
      ok: false,
      error: `Unknown delegate "${opts.agent}" — known delegates are ${order.join(", ")}.`,
      probed: entries,
    };
  }

  const chosen = opts.agent
    ? entries.find((e) => e.id === opts.agent && e.available)
    : order.map((id) => entries.find((e) => e.id === id)).find((e) => e?.available);

  if (!chosen?.path) {
    const wanted = opts.agent ? `Delegate "${opts.agent}" is not installed.` : "No delegate CLI is installed.";
    return {
      ok: false,
      error: `${wanted} Probed: ${describeProbe(entries)}. Install one of them, or do the work in this session instead.`,
      probed: entries,
    };
  }

  const spec = getDelegateSpec(chosen.id);
  const args = spec.argv(opts.prompt);

  // The command string is what imported deny rules match against, so it has to
  // be the real invocation rather than just the binary name.
  requireCommandAllowed([spec.binary, ...args].join(" "));

  // A delegate edits files under its working directory, so the profile is
  // consulted with write intent even though this host does no writing itself.
  const cwd = opts.cwd ? await validatePath(opts.cwd, "write") : undefined;

  const result = await runExecutable(chosen.path, args, {
    cwd,
    timeoutMs: (opts.timeoutSec ?? 300) * 1000,
    // One byte past the ceiling on purpose: `cap()` decides truncation by
    // comparing the captured text against MAX_DELEGATE_OUTPUT_BYTES, so the
    // capture has to be able to exceed it. Stopping the capture exactly at the
    // ceiling makes the flag depend on where the OS splits the stream — child
    // stdio is a unix socketpair, and its buffer is 212992 bytes on Linux but
    // reportedly 8192 on macOS (net.local.stream.sendspace), where 200 KiB is a
    // whole number of reads.
    maxOutputBytes: MAX_DELEGATE_OUTPUT_BYTES + 1,
  });

  const stdout = cap(result.stdout);
  const stderr = cap(result.stderr);

  return {
    ok: true,
    delegate: chosen.id,
    command: chosen.path,
    args,
    cwd,
    exitCode: result.exitCode,
    output: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    timedOut: result.timedOut,
  };
}
