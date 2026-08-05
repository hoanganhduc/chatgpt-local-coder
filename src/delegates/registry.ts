/**
 * Delegate CLIs — the local coding agents this host can hand a task to.
 *
 * A delegate is another agent CLI already installed on the machine. Handing it a
 * prompt is how a forked context is produced: the delegate gets its own model,
 * its own context window, and its own tool loop, and this host only sees the
 * text it prints.
 *
 * The delegate is NOT sandboxed by this host's permission profile. It runs as
 * the host user with whatever permissions its own configuration grants it.
 * Restricting `cwd` bounds where the work starts, not what the delegate may
 * touch.
 */

import { runExecutable, which } from "../lib/platform.js";

export type DelegateId = "claude" | "codex" | "grok" | "opencode";

export const DELEGATE_IDS: DelegateId[] = ["claude", "codex", "grok", "opencode"];

export interface DelegateSpec {
  id: DelegateId;
  /** Executable name looked up on PATH. */
  binary: string;
  /** Argv for a single non-interactive prompt. */
  argv: (prompt: string) => string[];
  /** Argv that prints a version and exits. */
  versionArgv: string[];
}

const SPECS: Record<DelegateId, DelegateSpec> = {
  claude: {
    id: "claude",
    binary: "claude",
    argv: (prompt) => ["-p", prompt, "--output-format", "text"],
    versionArgv: ["--version"],
  },
  codex: {
    id: "codex",
    binary: "codex",
    argv: (prompt) => ["exec", prompt],
    versionArgv: ["--version"],
  },
  grok: {
    id: "grok",
    binary: "grok",
    argv: (prompt) => ["-p", prompt],
    versionArgv: ["--version"],
  },
  opencode: {
    id: "opencode",
    binary: "opencode",
    argv: (prompt) => ["run", prompt],
    versionArgv: ["--version"],
  },
};

export function isDelegateId(value: string): value is DelegateId {
  return (DELEGATE_IDS as string[]).includes(value);
}

export function getDelegateSpec(id: DelegateId): DelegateSpec {
  return SPECS[id];
}

export interface DetectedDelegate {
  id: DelegateId;
  binary: string;
  /** Absolute path on PATH, or null when the CLI is not installed. */
  path: string | null;
  available: boolean;
  /** First line of `--version`, filled in only by `probeDelegates`. */
  version?: string;
}

/** Order the ids the way `delegates.order` asks, ignoring unknown names. */
export function orderDelegates(order: string[] | undefined): DelegateId[] {
  const requested = (order ?? []).filter(isDelegateId);
  const rest = DELEGATE_IDS.filter((id) => !requested.includes(id));
  return [...requested, ...rest];
}

/**
 * PATH lookup only — no subprocess. Cheap enough to run at startup.
 */
export function detectDelegates(order?: string[]): DetectedDelegate[] {
  return orderDelegates(order).map((id) => {
    const spec = SPECS[id];
    const found = which(spec.binary);
    return { id, binary: spec.binary, path: found ?? null, available: Boolean(found) };
  });
}

let probed: DetectedDelegate[] | null = null;

/**
 * PATH lookup plus a `--version` call for each CLI that exists. Cached, because
 * spawning four processes per tool call would be its own cost. Lazy, because
 * spawning them at startup would be a surprise for a host that never delegates.
 */
export async function probeDelegates(
  order?: string[],
  opts: { refresh?: boolean; timeoutMs?: number } = {}
): Promise<DetectedDelegate[]> {
  if (probed && !opts.refresh) return probed;

  const detected = detectDelegates(order);
  const results = await Promise.all(
    detected.map(async (entry) => {
      if (!entry.path) return entry;
      const spec = SPECS[entry.id];
      const run = await runExecutable(entry.path, spec.versionArgv, {
        timeoutMs: opts.timeoutMs ?? 10_000,
        maxOutputBytes: 4096,
      });
      const line = (run.stdout || run.stderr).split(/\r?\n/)[0]?.trim();
      return { ...entry, version: line || undefined };
    })
  );

  probed = results;
  return results;
}

export function resetDelegateProbe(): void {
  probed = null;
}
