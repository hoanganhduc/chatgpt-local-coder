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

/**
 * Where a delegate reads its prompt from. Off argv wherever the CLI allows it:
 * on Windows an npm-installed CLI is a `.cmd` shim, a shim can only be launched
 * through cmd.exe, and cmd.exe re-parses the command line it is handed. Keeping
 * model-supplied text off that command line removes the injection question
 * rather than answering it, and it is a layer under the quoting in
 * `platform.ts` rather than a replacement for it.
 *
 * "stdin" — written to the CLI's stdin, which is then closed.
 * "file"  — written to a file this host creates; only the path joins argv.
 * "argv"  — appended to argv, for a CLI that offers neither of the above.
 *
 * "argv" carries a cost on Windows and nowhere else: cmd.exe ends a command at
 * a line break whatever the quoting, so a multi-line prompt cannot be encoded
 * and `runExecutable` refuses it rather than truncating. Prefer "stdin" or
 * "file" for any CLI that supports one.
 */
export type PromptChannel = "stdin" | "file" | "argv";

export interface DelegateSpec {
  id: DelegateId;
  /** Executable name looked up on PATH. Literals only, no prompt text. */
  binary: string;
  /** Argv for a single non-interactive prompt. Literals only, no prompt text. */
  argv: string[];
  /** How the prompt reaches the CLI. A "file" spec gets the path appended. */
  promptVia: PromptChannel;
  /**
   * The invocation imported deny rules are matched against. It still spells the
   * prompt where it used to sit in argv, so a rule that blocked a prompt before
   * the prompt moved off the command line keeps blocking it.
   */
  denyArgv: (prompt: string) => string[];
  /** Argv that prints a version and exits. */
  versionArgv: string[];
}

const SPECS: Record<DelegateId, DelegateSpec> = {
  claude: {
    id: "claude",
    binary: "claude",
    // `-p` is a flag, not an option: with the prompt operand left off, the CLI
    // reads the prompt from stdin.
    argv: ["-p", "--output-format", "text"],
    promptVia: "stdin",
    denyArgv: (prompt) => ["-p", prompt, "--output-format", "text"],
    versionArgv: ["--version"],
  },
  codex: {
    id: "codex",
    binary: "codex",
    // `codex exec --help`: "If not provided as an argument (or if `-` is used),
    // instructions are read from stdin."
    argv: ["exec", "-"],
    promptVia: "stdin",
    denyArgv: (prompt) => ["exec", prompt],
    versionArgv: ["--version"],
  },
  grok: {
    id: "grok",
    binary: "grok",
    // grok has no stdin prompt mode — `-p/--single` requires an inline value —
    // so the prompt goes to a file and only that path travels in argv.
    argv: ["--prompt-file"],
    promptVia: "file",
    denyArgv: (prompt) => ["-p", prompt],
    versionArgv: ["--version"],
  },
  opencode: {
    id: "opencode",
    binary: "opencode",
    // opencode takes the message as an operand and has no stdin or file mode:
    // `opencode run` with stdin at EOF exits with "You must provide a message
    // or a command". The prompt therefore stays in argv, where the Windows
    // quoting in platform.ts is what protects it.
    argv: ["run"],
    promptVia: "argv",
    denyArgv: (prompt) => ["run", prompt],
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
        // A CLI that reads its prompt from stdin must see EOF here, or the
        // version probe waits on a pipe nobody is going to write to.
        stdin: "",
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
