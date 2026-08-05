/**
 * Skill execution.
 *
 * A skill that declares a `runtime` and an `entrypoint` is executable: the host
 * spawns the interpreter directly on the entrypoint file. Running the
 * interpreter as an argv vector rather than through a shell string means a skill
 * path containing spaces or quotes cannot turn into extra shell words.
 *
 * The privilege boundary is the same one that applies to `run_command`: the
 * child runs as the host user. Skill execution is gated by
 * `skills.allowExecution` and by the permission profile, not sandboxed.
 */

import fs from "fs/promises";
import path from "path";
import { isWindows, platformId, runExecutable, which, type RunResult } from "../lib/platform.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { findSkill, skillSupportsPlatform } from "./registry.js";
import type { DiscoveredSkill } from "./discover.js";

export const SKILL_RUNTIMES = ["node", "python", "bash", "powershell", "none"] as const;
export type SkillRuntime = (typeof SKILL_RUNTIMES)[number];

export interface SkillRunOptions {
  args?: string[];
  cwd?: string;
  timeoutSec?: number;
  /** Set false to refuse execution regardless of frontmatter. */
  allowExecution?: boolean;
  /** Overrides the detected platform; used by tests. */
  platform?: string;
}

export interface SkillRunResult {
  skill: string;
  runtime: SkillRuntime;
  entrypoint: string;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function isSkillRuntime(value: string | undefined): value is SkillRuntime {
  return !!value && (SKILL_RUNTIMES as readonly string[]).includes(value);
}

/**
 * Resolve the interpreter for a runtime. Returns the executable name to spawn,
 * or an error string explaining what is missing on this platform.
 */
function resolveInterpreter(
  runtime: SkillRuntime,
  skillName: string,
  platform: string
): { command: string; leadingArgs: string[] } | { error: string } {
  switch (runtime) {
    case "node":
      return { command: process.execPath, leadingArgs: [] };

    case "python": {
      // Windows ships `python`; most Linux/macOS installs expose `python3`.
      const candidates = platform === "win32" ? ["python", "python3"] : ["python3", "python"];
      for (const candidate of candidates) {
        const found = which(candidate);
        if (found) return { command: found, leadingArgs: [] };
      }
      return {
        error: `skill "${skillName}" requires python; install Python and ensure ${candidates.join(" or ")} is on PATH`,
      };
    }

    case "bash": {
      const found = which("bash");
      if (found) return { command: found, leadingArgs: [] };
      if (platform === "win32") {
        return { error: `skill "${skillName}" requires bash; install Git Bash or run under WSL` };
      }
      return { error: `skill "${skillName}" requires bash; install bash and ensure it is on PATH` };
    }

    case "powershell": {
      const found = which("pwsh") || (platform === "win32" ? which("powershell") : undefined);
      if (found) {
        return { command: found, leadingArgs: ["-NoProfile", "-NonInteractive", "-File"] };
      }
      return {
        error: `skill "${skillName}" requires powershell; install PowerShell 7 (pwsh) and ensure it is on PATH`,
      };
    }

    case "none":
      return { error: `skill "${skillName}" declares runtime "none" and is documentation only` };
  }
}

/**
 * Resolve `entrypoint` against the skill directory and refuse anything that
 * escapes it. A skill is a self-contained unit; letting its entrypoint point at
 * `../../something` would make the skill file a way to execute an arbitrary
 * path on the host.
 */
async function resolveEntrypoint(skill: DiscoveredSkill): Promise<string> {
  const declared = skill.frontmatter.entrypoint?.trim();
  if (!declared) {
    throw new Error(`skill "${skill.name}" declares no entrypoint`);
  }

  const resolved = path.resolve(skill.dir, declared);
  const base = path.resolve(skill.dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(
      `skill "${skill.name}" entrypoint "${declared}" resolves outside its own directory (${resolved})`
    );
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`skill "${skill.name}" entrypoint not found: ${resolved}`);
  }

  return resolved;
}

export async function runSkill(
  nameOrSkill: string | DiscoveredSkill,
  opts: SkillRunOptions = {}
): Promise<SkillRunResult> {
  const skill = typeof nameOrSkill === "string" ? findSkill(nameOrSkill) : nameOrSkill;
  if (!skill) {
    throw new Error(`skill "${String(nameOrSkill)}" not found — call skill_list to see available skills`);
  }

  if (opts.allowExecution === false) {
    throw new Error(
      `skill execution is disabled (skills.allowExecution = false); skill "${skill.name}" was not run`
    );
  }

  requireCommandAllowed(`skill:${skill.name}`);

  const platform = opts.platform ?? platformId();
  if (!skillSupportsPlatform(skill, platform)) {
    const declared = (skill.frontmatter.platforms ?? []).join(", ");
    throw new Error(
      `skill "${skill.name}" does not support platform "${platform}" (declares: ${declared})`
    );
  }

  const runtime = skill.frontmatter.runtime?.trim();
  if (!runtime) {
    throw new Error(
      `skill "${skill.name}" declares no runtime and is documentation only — read it with skill_read and follow its instructions`
    );
  }
  if (!isSkillRuntime(runtime)) {
    throw new Error(
      `skill "${skill.name}" declares runtime "${runtime}"; expected one of ${SKILL_RUNTIMES.join(", ")}`
    );
  }

  const entrypoint = await resolveEntrypoint(skill);
  const interpreter = resolveInterpreter(runtime, skill.name, platform);
  if ("error" in interpreter) throw new Error(interpreter.error);

  const args = [...interpreter.leadingArgs, entrypoint, ...(opts.args ?? [])];
  const timeoutMs = Math.max(1, opts.timeoutSec ?? 300) * 1000;

  const result: RunResult = await runExecutable(interpreter.command, args, {
    cwd: opts.cwd ?? skill.dir,
    timeoutMs,
    env: { ...process.env, SKILL_DIR: skill.dir, SKILL_NAME: skill.name },
  });

  return {
    skill: skill.name,
    runtime,
    entrypoint,
    command: interpreter.command,
    args,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}

/** Diagnostic helper: which runtimes this host can actually execute. */
export function availableRuntimes(): Record<SkillRuntime, boolean> {
  return {
    node: true,
    python: Boolean(which("python3") || which("python")),
    bash: Boolean(which("bash")),
    powershell: Boolean(which("pwsh") || (isWindows() && which("powershell"))),
    none: false,
  };
}
