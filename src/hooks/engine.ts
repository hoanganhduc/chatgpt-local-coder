/**
 * Hooks engine.
 *
 * Hooks come from two places:
 *
 *   - Imported settings, in the Claude Code shape
 *     `{ matcher, hooks: [{ type: "command", command, timeoutSec? }] }`, so a
 *     user's existing `~/.claude/settings.json` works unchanged.
 *   - Internal registrations from this codebase — currently the post-edit
 *     checks, which used to be called directly from the filesystem tools.
 *
 * What a hook may do depends on the event:
 *
 *   - `PreToolUse` runs before the tool. A command hook that exits non-zero
 *     blocks the call, and its stderr is returned to the model as the reason.
 *   - `PostToolUse` runs after. Its outcome is reported and can enrich the tool
 *     result, but a failure never turns a successful tool call into an error.
 *   - `SessionStart` and `Stop` are lifecycle notifications with no tool
 *     attached; neither can block anything.
 *
 * Every hook command runs through the host shell as the host user and is
 * subject to the command permission policy — a hook is not a way around a
 * `readonly` profile or an imported deny rule.
 */

import { defaultShell, runExecutable } from "../lib/platform.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import type { HookMatcher } from "../settings/types.js";
import { matchesTool } from "./matchers.js";

export const HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Whole-event ceiling. One slow hook must not stall every tool call. */
export const HOOK_BUDGET_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 15_000;
const MAX_HOOK_OUTPUT = 4000;

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

export interface HookContext {
  event: HookEvent;
  /** Absent for SessionStart and Stop. */
  tool?: string;
  input?: unknown;
  /** The tool's result payload, for PostToolUse. */
  result?: unknown;
  sessionId?: string;
  cwd?: string;
}

export interface InternalHook {
  name: string;
  /** Same semantics as a settings matcher. */
  matcher?: string;
  /**
   * Returning `{ block }` from a PreToolUse hook aborts the tool call.
   * Returning `{ enrich }` from a PostToolUse hook merges those keys into the
   * tool result payload.
   */
  run: (ctx: HookContext) => Promise<{ block?: string; enrich?: Record<string, unknown> } | undefined>;
}

export interface HookRunResult {
  hook: string;
  source: "command" | "internal";
  matcher?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  skipped?: string;
  error?: string;
  blocked?: boolean;
}

export interface HookReport {
  event: HookEvent;
  results: HookRunResult[];
  blocked?: { hook: string; reason: string };
  enrich?: Record<string, unknown>;
}

interface HookState {
  enabled: boolean;
  matchers: Record<string, HookMatcher[]>;
}

const state: HookState = { enabled: true, matchers: {} };
const internal = new Map<HookEvent, InternalHook[]>();

export function setHookConfig(next: { enabled?: boolean; matchers?: Record<string, HookMatcher[]> }): void {
  if (next.enabled !== undefined) state.enabled = next.enabled;
  if (next.matchers) state.matchers = next.matchers;
}

export function getHookConfig(): HookState {
  return { enabled: state.enabled, matchers: state.matchers };
}

export function registerInternalHook(event: HookEvent, hook: InternalHook): void {
  const list = internal.get(event) ?? [];
  // Re-registering the same name replaces it, so a reload does not double-run.
  internal.set(event, [...list.filter((h) => h.name !== hook.name), hook]);
}

export function clearInternalHooks(event?: HookEvent): void {
  if (event) internal.delete(event);
  else internal.clear();
}

export function resetHooks(): void {
  state.enabled = true;
  state.matchers = {};
  internal.clear();
}

/**
 * True when at least one hook could fire for this event and tool. The tool
 * wrapper calls this first so a host with no hooks configured pays nothing.
 */
export function hasHooks(event: HookEvent, tool?: string): boolean {
  if (!state.enabled) return false;
  const commands = state.matchers[event] ?? [];
  if (commands.some((entry) => entry.hooks?.length && matchesTool(entry.matcher, tool ?? ""))) return true;
  return (internal.get(event) ?? []).some((hook) => matchesTool(hook.matcher, tool ?? ""));
}

function truncate(text: string): string {
  return text.length > MAX_HOOK_OUTPUT ? `${text.slice(0, MAX_HOOK_OUTPUT)}\n… (truncated)` : text;
}

function hookEnv(ctx: HookContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLC_HOOK_EVENT: ctx.event,
    CLC_TOOL_NAME: ctx.tool ?? "",
    CLC_SESSION_ID: ctx.sessionId ?? "",
  };
}

/** The JSON a hook command reads on stdin — the Claude Code convention. */
function hookPayload(ctx: HookContext): string {
  return JSON.stringify({
    hook_event_name: ctx.event,
    tool_name: ctx.tool,
    tool_input: ctx.input,
    tool_response: ctx.result,
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
  });
}

async function runCommandHook(
  command: string,
  timeoutMs: number,
  ctx: HookContext
): Promise<HookRunResult> {
  const base: HookRunResult = { hook: command, source: "command" };

  try {
    requireCommandAllowed(command);
  } catch (error) {
    // A hook the profile forbids has not run, so it has not decided anything.
    // It is reported rather than treated as a block.
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }

  const shell = defaultShell();
  const result = await runExecutable(shell.command, shell.args(command), {
    cwd: ctx.cwd,
    timeoutMs,
    env: hookEnv(ctx),
    maxOutputBytes: MAX_HOOK_OUTPUT * 2,
    stdin: hookPayload(ctx),
  });

  return {
    ...base,
    exitCode: result.exitCode,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    timedOut: result.timedOut,
  };
}

export async function runHooks(ctx: HookContext): Promise<HookReport> {
  const report: HookReport = { event: ctx.event, results: [] };
  if (!state.enabled) return report;

  const started = Date.now();
  const remaining = (): number => HOOK_BUDGET_MS - (Date.now() - started);

  const enrich: Record<string, unknown> = {};

  // Internal hooks run first: they are this host's own behaviour, and a user
  // hook should not be able to starve them of the budget.
  for (const hook of internal.get(ctx.event) ?? []) {
    if (!matchesTool(hook.matcher, ctx.tool ?? "")) continue;
    if (remaining() <= 0) {
      report.results.push({ hook: hook.name, source: "internal", skipped: "hook budget exhausted" });
      continue;
    }
    try {
      const outcome = await hook.run(ctx);
      if (outcome?.enrich) Object.assign(enrich, outcome.enrich);
      if (outcome?.block && ctx.event === "PreToolUse") {
        report.results.push({ hook: hook.name, source: "internal", blocked: true });
        report.blocked = { hook: hook.name, reason: outcome.block };
        report.enrich = Object.keys(enrich).length ? enrich : undefined;
        return report;
      }
      report.results.push({ hook: hook.name, source: "internal" });
    } catch (error) {
      report.results.push({
        hook: hook.name,
        source: "internal",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const entry of state.matchers[ctx.event] ?? []) {
    if (!matchesTool(entry.matcher, ctx.tool ?? "")) continue;

    for (const action of entry.hooks ?? []) {
      if (action.type !== "command" || !action.command?.trim()) continue;

      const budget = remaining();
      if (budget <= 0) {
        report.results.push({
          hook: action.command,
          source: "command",
          matcher: entry.matcher,
          skipped: "hook budget exhausted",
        });
        continue;
      }

      const timeoutMs = Math.min(
        action.timeoutSec ? action.timeoutSec * 1000 : DEFAULT_HOOK_TIMEOUT_MS,
        budget
      );
      const result = await runCommandHook(action.command, timeoutMs, ctx);
      result.matcher = entry.matcher;

      // A hook that never ran — forbidden by the profile, killed on timeout, or
      // never spawned — has not decided anything, so only a real non-zero exit
      // blocks. `timedOut` has to be consulted explicitly rather than inferred
      // from a null exit code: that inference holds only on POSIX, where a
      // SIGKILLed child reports no code at all. Windows has no signals, and
      // `taskkill /F` sets exit code 1, so on Windows a hook that was merely
      // slow used to be indistinguishable from one that deliberately refused —
      // and blocked the call. A forbidden or unspawnable hook still reaches
      // here as a null exit code, which the typeof guard rejects.
      const failed = !result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0;
      if (ctx.event === "PreToolUse" && failed) {
        result.blocked = true;
        report.results.push(result);
        report.blocked = {
          hook: action.command,
          reason: result.stderr || result.stdout || `hook exited ${result.exitCode}`,
        };
        report.enrich = Object.keys(enrich).length ? enrich : undefined;
        return report;
      }

      report.results.push(result);
    }
  }

  report.enrich = Object.keys(enrich).length ? enrich : undefined;
  return report;
}
