import { CODEX_AGENT_PROMPT } from "./codex-agent-prompt.js";
import {
  collectGitSnapshot,
  formatEnvironmentForInstructions,
  formatGitSnapshotForInstructions,
  type GitSnapshot,
} from "./git-snapshot.js";
import {
  formatProjectMemoryForInstructions,
  loadProjectMemory,
  type ProjectMemoryBundle,
} from "./project-memory.js";
import { appendAutoMemory, formatAutoMemoryForInstructions, loadAutoMemory } from "./auto-memory.js";
import {
  formatSkillsForInstructions,
  getSkillRegistry,
  isSkillRegistryLoaded,
  loadSkillRegistry,
} from "../skills/registry.js";
import { getChatGptToolProfile } from "./tool-profile.js";
import { buildServerInstructions } from "./quickstart.js";

export interface InstructionContextOptions {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
  /** Whether the active profile permits writes outside the workspace roots. */
  fullDiskAccess: boolean;
}

export interface InstructionContext {
  projectMemory: ProjectMemoryBundle;
  git: GitSnapshot;
  instructionsText: string;
  instructionBytes: number;
}

export async function buildInstructionContext(
  opts: InstructionContextOptions
): Promise<InstructionContext> {
  // The registry is normally loaded once at startup; load it here when a caller
  // builds instructions without having gone through that path.
  const registry = isSkillRegistryLoaded()
    ? getSkillRegistry()
    : await loadSkillRegistry({ workspaceRoots: opts.workspaceRoots });

  const [projectMemory, git, autoMemory] = await Promise.all([
    loadProjectMemory(opts.workspaceRoot, { workspaceRoots: opts.workspaceRoots }),
    collectGitSnapshot(opts.workspaceRoot),
    loadAutoMemory(opts.workspaceRoot),
  ]);

  const profile = getChatGptToolProfile();

  const blocks = [
    CODEX_AGENT_PROMPT,
    `Tool profile: **${profile}** (${profile === "slim" ? "core tools only — optimal for ChatGPT web" : "all tools exposed"}).`,
    formatEnvironmentForInstructions({
      workspaceRoot: opts.workspaceRoot,
      workspaceRoots: opts.workspaceRoots,
      pid: opts.pid,
      adminPort: opts.adminPort,
      nodeVersion: process.version,
    }),
    formatGitSnapshotForInstructions(git),
    formatAutoMemoryForInstructions(autoMemory),
    formatProjectMemoryForInstructions(projectMemory),
    formatSkillsForInstructions(registry.skills),
  ].filter(Boolean);

  const projectMemoryBlock = blocks.join("\n\n");
  const instructionsText = buildServerInstructions(
    opts.workspaceRoot,
    opts.workspaceRoots,
    opts.fullDiskAccess,
    projectMemoryBlock
  );

  return {
    projectMemory,
    git,
    instructionsText,
    instructionBytes: Buffer.byteLength(instructionsText, "utf-8"),
  };
}

export function summarizeInstructionContext(ctx: InstructionContext): Record<string, unknown> {
  const pm = ctx.projectMemory;
  return {
    root: pm.root,
    workspace_roots: pm.workspace_roots,
    memory_contract_version: "clc.project-memory-summary.v1",
    memory_limits: pm.memory_limits,
    // Public boundary mapping: the bundle tracks sources with the internal
    // camelCase key names; the public object must use exactly the same two
    // keys as memory_limits (plan §14.1 / review REV-R01).
    memory_limit_sources: {
      max_lines_per_section: pm.memory_limit_sources.maxLines,
      max_content_bytes: pm.memory_limit_sources.maxBytes,
    },
    memory_files: pm.sections.map((s) => ({
      path: s.path,
      kind: s.kind,
      truncated: s.truncated,
      content_bytes: s.content_bytes,
      truncation_reasons: s.truncation_reasons,
    })),
    // Public summary exposes omission counts only; per-file omission details
    // (bundle.omitted_sections) stay out of the unauthenticated health surface.
    memory_omitted_counts: pm.memory_omitted_counts,
    memory_bytes: pm.total_bytes,
    instruction_bytes: ctx.instructionBytes,
    git: ctx.git.is_repo
      ? { branch: ctx.git.branch, commits: ctx.git.recent_commits?.length ?? 0 }
      : { is_repo: false },
    loaded_at: pm.loaded_at,
    tool_profile: getChatGptToolProfile(),
  };
}

export { appendAutoMemory };