import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { platformId } from "../lib/platform.js";
import {
  findSkill,
  getSkillRegistry,
  refreshSkills,
  skillSupportsPlatform,
} from "../skills/registry.js";
import { availableRuntimes, runSkill } from "../skills/run.js";
import type { DiscoveredSkill } from "../skills/discover.js";

export interface SkillToolOptions {
  /** From `skills.allowExecution`. */
  allowExecution: boolean;
  /** From `skills.maxRuntimeSec`. */
  maxRuntimeSec: number;
}

function summarize(skill: DiscoveredSkill) {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.file,
    root: skill.root.path,
    origin: skill.root.origin,
    runtime: skill.frontmatter.runtime ?? null,
    entrypoint: skill.frontmatter.entrypoint ?? null,
    platforms: skill.frontmatter.platforms ?? null,
    context: skill.frontmatter.context ?? null,
    model: skill.frontmatter.model ?? null,
    agent: skill.frontmatter.agent ?? null,
    executable: Boolean(skill.frontmatter.entrypoint && skill.frontmatter.runtime),
    supported_here: skillSupportsPlatform(skill),
  };
}

export function registerSkillTools(server: McpServer, opts: SkillToolOptions): void {
  server.registerTool(
    "skill_list",
    {
      title: "List Skills",
      description:
        "List every discovered skill with its description, source root, and runtime. Use when the instruction summary was truncated or a skill name is unknown.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring match on name or description"),
        refresh: z.boolean().optional().describe("Re-scan skill roots before listing"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ filter, refresh }) => {
      const registry = refresh ? await refreshSkills() : getSkillRegistry();
      const needle = filter?.trim().toLowerCase();
      const skills = needle
        ? registry.skills.filter(
            (s) =>
              s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)
          )
        : registry.skills;

      return toolResult(
        "skill_list",
        {
          skills: skills.map(summarize),
          count: skills.length,
          total: registry.skills.length,
          roots: registry.roots.map((r) => ({ path: r.path, origin: r.origin })),
          shadowed: registry.shadowed,
          filtered_out: registry.filtered,
          platform: platformId(),
          runtimes: availableRuntimes(),
          loaded_at: registry.loadedAt,
        },
        { summary: `skill_list: ${skills.length} of ${registry.skills.length} skill(s)` }
      );
    }
  );

  server.registerTool(
    "skill_read",
    {
      title: "Read Skill",
      description:
        "Read a skill's full instructions (the SKILL.md body) plus its frontmatter. Call this before following a skill — the instruction summary carries only name and description.",
      inputSchema: {
        name: z.string().describe("Skill name as shown by skill_list"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ name }) => {
      const skill = findSkill(name);
      if (!skill) {
        return toolError("skill_read", `skill "${name}" not found — call skill_list to see available skills`);
      }

      await audit({ tool: "skill_read", action: "read", target: skill.file, status: "ok" });
      return toolResult(
        "skill_read",
        {
          ...summarize(skill),
          frontmatter: skill.frontmatter.raw,
          allowed_tools: skill.frontmatter.allowedTools ?? null,
          hooks: skill.frontmatter.hooks ?? null,
          body: skill.body,
        },
        { summary: `skill_read: ${skill.name}` }
      );
    }
  );

  server.registerTool(
    "skill_run",
    {
      title: "Run Skill",
      description:
        "Execute a skill's declared entrypoint. Only skills with both `runtime` and `entrypoint` in frontmatter are executable; documentation-only skills should be read with skill_read instead. The script runs as the host user.",
      inputSchema: {
        name: z.string().describe("Skill name as shown by skill_list"),
        args: z.array(z.string()).optional().describe("Arguments passed to the entrypoint"),
        cwd: z.string().optional().describe("Working directory, defaults to the skill directory"),
        timeout_sec: z.number().int().positive().optional().describe("Overrides skills.maxRuntimeSec (capped by it)"),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ name, args, cwd, timeout_sec }) => {
      try {
        // The configured ceiling is a ceiling: a caller may ask for less time,
        // never more.
        const timeoutSec = Math.min(timeout_sec ?? opts.maxRuntimeSec, opts.maxRuntimeSec);
        const result = await runSkill(name, {
          args,
          cwd,
          timeoutSec,
          allowExecution: opts.allowExecution,
        });

        await audit({
          tool: "skill_run",
          action: "execute",
          target: result.entrypoint,
          status: result.exitCode === 0 ? "ok" : "error",
          details: { skill: result.skill, runtime: result.runtime, exit_code: result.exitCode },
        });

        return toolResult(
          "skill_run",
          {
            skill: result.skill,
            runtime: result.runtime,
            entrypoint: result.entrypoint,
            args: result.args,
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exitCode,
            timed_out: result.timedOut,
          },
          {
            ok: result.exitCode === 0 && !result.timedOut,
            summary: result.timedOut
              ? `skill_run: ${result.skill} timed out after ${timeoutSec}s`
              : `skill_run: ${result.skill} exit ${result.exitCode}`,
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await audit({ tool: "skill_run", action: "execute", target: name, status: "error", details: { message } });
        return toolError("skill_run", message);
      }
    }
  );
}
