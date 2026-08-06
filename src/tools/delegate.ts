import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { probeDelegates, runDelegate } from "../delegates/index.js";
import { findSkill } from "../skills/registry.js";

export interface DelegateToolOptions {
  /** From `delegates.enabled`. */
  enabled: boolean;
  /** From `delegates.order`. */
  order: string[];
  /** From `delegates.timeoutSec`. */
  timeoutSec: number;
}

/**
 * Compose the prompt handed to the delegate.
 *
 * A skill marked `context: fork` is written to be executed in a context of its
 * own, so its whole body travels with the prompt — the delegate cannot call
 * `skill_read` against this host.
 */
function buildPrompt(prompt: string, skillBody?: string, skillName?: string): string {
  if (!skillBody) return prompt;
  return [
    `You are running the "${skillName}" skill. Its full instructions follow.`,
    "",
    skillBody.trim(),
    "",
    "---",
    "",
    "Task:",
    prompt,
  ].join("\n");
}

export function registerDelegateTools(server: McpServer, opts: DelegateToolOptions): void {
  server.registerTool(
    "agent_delegate",
    {
      title: "Delegate To Local Agent",
      description:
        "Hand a self-contained task to another coding agent CLI installed on this machine (claude, codex, grok, opencode) and return its output. Use for work that deserves its own context: a long investigation, a skill marked `context: fork`, or a second opinion. The delegate runs as the host user and is not restricted by this host's permission profile.",
      inputSchema: {
        prompt: z.string().describe("The complete task. The delegate sees nothing else from this conversation."),
        agent: z
          .string()
          .optional()
          .describe("Force a specific CLI (claude, codex, grok, opencode); default is the first installed one"),
        skill: z
          .string()
          .optional()
          .describe("Skill name whose instructions are prepended to the prompt (for `context: fork` skills)"),
        cwd: z.string().optional().describe("Working directory for the delegate; must be allowed by the permission profile"),
        timeout_sec: z.number().int().positive().optional().describe("Overrides delegates.timeoutSec (capped by it)"),
      },
      annotations: toolAnnotations("command", { openWorld: true }),
    },
    async ({ prompt, agent, skill, cwd, timeout_sec }) => {
      let body: string | undefined;
      let skillName: string | undefined;
      let preferred = agent;

      if (skill) {
        const found = findSkill(skill);
        if (!found) {
          return toolError("agent_delegate", `skill "${skill}" not found — call skill_list to see available skills`);
        }
        body = found.body;
        skillName = found.name;
        // A skill may name the agent it wants; an explicit argument still wins.
        preferred = agent ?? found.frontmatter.agent;
      }

      const timeoutSec = Math.min(timeout_sec ?? opts.timeoutSec, opts.timeoutSec);

      try {
        const result = await runDelegate({
          prompt: buildPrompt(prompt, body, skillName),
          agent: preferred,
          cwd,
          timeoutSec,
          order: opts.order,
          enabled: opts.enabled,
        });

        if (!result.ok) {
          await audit({
            tool: "agent_delegate",
            action: "execute",
            target: preferred ?? "auto",
            status: "error",
            details: { message: result.error },
          });
          return toolError("agent_delegate", result.error, {
            probed: result.probed.map((p) => ({ id: p.id, binary: p.binary, available: p.available })),
          });
        }

        await audit({
          tool: "agent_delegate",
          action: "execute",
          target: result.delegate,
          status: result.exitCode === 0 ? "ok" : "error",
          details: { skill: skillName, exit_code: result.exitCode, cwd: result.cwd },
        });

        return toolResult(
          "agent_delegate",
          {
            delegate: result.delegate,
            skill: skillName ?? null,
            cwd: result.cwd ?? null,
            exit_code: result.exitCode,
            output: result.output,
            stderr: result.stderr,
            truncated: result.truncated,
            timed_out: result.timedOut,
          },
          {
            ok: result.exitCode === 0 && !result.timedOut,
            summary: result.timedOut
              ? `agent_delegate: ${result.delegate} timed out after ${timeoutSec}s`
              : `agent_delegate: ${result.delegate} exit ${result.exitCode}`,
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await audit({
          tool: "agent_delegate",
          action: "execute",
          target: preferred ?? "auto",
          status: "error",
          details: { message },
        });
        return toolError("agent_delegate", message);
      }
    }
  );

  server.registerTool(
    "delegate_status",
    {
      title: "Delegate Status",
      description:
        "List the local agent CLIs available for delegation, with the version each one reports and the order agent_delegate will try them in.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Re-probe PATH instead of using the cached result"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ refresh }) => {
      const entries = await probeDelegates(opts.order, { refresh });
      const available = entries.filter((e) => e.available);

      return toolResult(
        "delegate_status",
        {
          enabled: opts.enabled,
          order: entries.map((e) => e.id),
          timeout_sec: opts.timeoutSec,
          delegates: entries.map((e) => ({
            id: e.id,
            binary: e.binary,
            path: e.path,
            available: e.available,
            version: e.version ?? null,
          })),
          note: "A delegate runs as the host user with its own configuration; this host's permission profile does not constrain it.",
        },
        { summary: `delegate_status: ${available.length} of ${entries.length} delegate CLI(s) available` }
      );
    }
  );
}
