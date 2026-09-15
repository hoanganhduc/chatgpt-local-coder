import fs from "fs/promises";
import os from "os";
import path from "path";

const ROOT_MEMORY_FILES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "CLAUDE.local.md",
] as const;

// First match wins. This host's own home comes first: it is where
// `ai-agents-skills` writes managed instruction blocks for the
// `chatgpt-local-coder` target, and a block installed for this host should not
// be shadowed by another agent's file.
const USER_MEMORY_CANDIDATES = [
  path.join(os.homedir(), ".chatgpt-local-coder", "AGENTS.md"),
  path.join(os.homedir(), ".codex", "CLAUDE.md"),
  path.join(os.homedir(), ".claude", "CLAUDE.md"),
] as const;

const RULES_GLOB_MAX = 12;
const IMPORT_MAX_DEPTH = 4;

export const PROJECT_MEMORY_DEFAULT_MAX_LINES = 500;
export const PROJECT_MEMORY_DEFAULT_MAX_BYTES = 32 * 1024;

/**
 * Per-key source resolution (plan §13.1). Both keys resolve independently:
 * `opts` > non-empty `env` > default. Only the selected source is validated;
 * an invalid env value masked by a valid opts value must not fail the call.
 */
const LIMIT_SPECS = {
  maxLines: {
    env: "PROJECT_MEMORY_MAX_LINES",
    default: PROJECT_MEMORY_DEFAULT_MAX_LINES,
  },
  maxBytes: {
    env: "PROJECT_MEMORY_MAX_BYTES",
    default: PROJECT_MEMORY_DEFAULT_MAX_BYTES,
  },
} as const;

export type ProjectMemoryLimitKey = keyof typeof LIMIT_SPECS;
export type ProjectMemoryLimitSource = "default" | "env" | "opts";
export type ProjectMemoryTruncationReason = "line_limit" | "byte_limit";
export type ProjectMemoryOmissionReason =
  | "byte_budget_exhausted"
  | "empty_after_transform"
  | "empty_after_limits"
  | "unreadable";

export class ProjectMemoryConfigError extends Error {
  readonly code = "ERR_PROJECT_MEMORY_LIMIT" as const;
  readonly key: ProjectMemoryLimitKey;
  readonly source: "opts" | "env";

  constructor(key: ProjectMemoryLimitKey, source: "opts" | "env") {
    super(
      `Invalid project memory limit: ${key} (${source}); expected a positive safe integer.`
    );
    this.name = "ProjectMemoryConfigError";
    this.key = key;
    this.source = source;
  }
}

export interface ProjectMemoryOptions {
  maxBytes?: number;
  maxLines?: number;
  workspaceRoots?: string[];
}

export interface ProjectMemorySection {
  path: string;
  content: string;
  truncated: boolean;
  kind: "user" | "project" | "rule" | "import";
  content_bytes: number;
  truncation_reasons: ProjectMemoryTruncationReason[];
}

/** Internal diagnostic for a selected candidate that produced no content. */
export interface OmittedMemorySection {
  path: string;
  kind: ProjectMemorySection["kind"];
  reason: ProjectMemoryOmissionReason;
  truncation_reasons: ProjectMemoryTruncationReason[];
}

export interface ProjectMemoryLimits {
  max_lines_per_section: number;
  max_content_bytes: number;
}

export interface ProjectMemoryBundle {
  root: string;
  workspace_roots: string[];
  sections: ProjectMemorySection[];
  total_bytes: number;
  loaded_at: string;
  memory_limits: ProjectMemoryLimits;
  memory_limit_sources: Record<ProjectMemoryLimitKey, ProjectMemoryLimitSource>;
  memory_omitted_counts: Record<ProjectMemoryOmissionReason, number>;
  /** Candidate-order diagnostics. Public health exposes only the counts. */
  omitted_sections: OmittedMemorySection[];
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function resolveLimit(
  key: ProjectMemoryLimitKey,
  opts: ProjectMemoryOptions | undefined
): { value: number; source: ProjectMemoryLimitSource } {
  const spec = LIMIT_SPECS[key];
  const optValue = opts?.[key];
  if (optValue !== undefined) {
    // `undefined` means absent; anything else supplied must be a positive
    // safe integer or the call rejects with source=opts (no fallback).
    if (!isPositiveSafeInteger(optValue)) {
      throw new ProjectMemoryConfigError(key, "opts");
    }
    return { value: optValue, source: "opts" };
  }

  const rawEnv = process.env[spec.env];
  const trimmed = rawEnv === undefined ? "" : rawEnv.trim();
  if (trimmed === "") return { value: spec.default, source: "default" };
  // Only ASCII digits; `00500` and ` 500 ` are valid 500, while `+500`,
  // `5e2`, `500.0`, `500abc` and friends reject instead of parseInt prefixes.
  if (!/^[0-9]+$/.test(trimmed)) throw new ProjectMemoryConfigError(key, "env");
  const parsed = Number(trimmed);
  if (!isPositiveSafeInteger(parsed)) throw new ProjectMemoryConfigError(key, "env");
  return { value: parsed, source: "env" };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Longest prefix of `text` whose UTF-8 byte length fits `budget` and that ends
 * on a Unicode code-point boundary. Multibyte characters are never cut in the
 * middle, so valid UTF-8 input never gains U+FFFD from truncation.
 */
function utf8PrefixWithinBudget(text: string, budget: number): string {
  const buf = Buffer.from(text, "utf-8");
  let end = Math.min(budget, buf.length);
  while (end > 0) {
    const b = buf[end - 1];
    if ((b & 0x80) === 0) break; // ASCII: clean boundary
    if ((b & 0xc0) === 0x80) {
      end--; // continuation byte: back off
      continue;
    }
    const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
    const charEnd = end - 1 + len;
    if (charEnd <= budget) {
      end = charEnd; // whole character fits: move past it
      break;
    }
    end--; // lead byte of a character that would be cut: back off
  }
  return buf.subarray(0, end).toString("utf-8");
}

function hasPathsFrontmatter(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^paths\s*:/m.test(match[1]);
}

interface ReadMemoryOutcome {
  section?: ProjectMemorySection;
  omission?: { reason: ProjectMemoryOmissionReason; truncation_reasons: ProjectMemoryTruncationReason[] };
}

/**
 * Plan §13.2 pipeline for one readable candidate with remaining budget B > 0:
 * S = comment removal + import expansion + CRLF→LF normalization;
 * L = first maxLines lines of S; P = longest UTF-8 code-point-boundary prefix
 * of L within B bytes; content = P.trim(). Reasons are recorded in
 * line-then-byte order; a candidate that empties out is an omission, not a
 * hard stop for the remaining candidates.
 */
async function readTextLimited(
  filePath: string,
  budgetBytes: number,
  maxLines: number,
  kind: ProjectMemorySection["kind"]
): Promise<ReadMemoryOutcome> {
  let full: string;
  try {
    const buf = await fs.readFile(filePath);
    full = stripHtmlComments(buf.toString("utf-8"));
  } catch {
    return { omission: { reason: "unreadable", truncation_reasons: [] } };
  }
  full = await expandImportsInContent(full, path.dirname(filePath));

  const s = full.replace(/\r\n/g, "\n");
  if (s.trim() === "") {
    return { omission: { reason: "empty_after_transform", truncation_reasons: [] } };
  }

  const reasons: ProjectMemoryTruncationReason[] = [];
  let l = s;
  if (s.split("\n").length > maxLines) {
    l = s.split("\n").slice(0, maxLines).join("\n");
    if (l.trim() !== s.trim()) reasons.push("line_limit");
  }

  let p = l;
  if (Buffer.byteLength(l, "utf-8") > budgetBytes) {
    p = utf8PrefixWithinBudget(l, budgetBytes);
    if (p.trim() !== l.trim()) reasons.push("byte_limit");
  }

  const content = p.trim();
  if (content === "") {
    return { omission: { reason: "empty_after_limits", truncation_reasons: reasons } };
  }
  return {
    section: {
      path: filePath,
      content,
      truncated: reasons.length > 0,
      kind,
      content_bytes: Buffer.byteLength(content, "utf-8"),
      truncation_reasons: reasons,
    },
  };
}

async function expandImportsInContent(content: string, baseDir: string): Promise<string> {
  const visited = new Set<string>();
  return expandMemoryImportsAsync(content, baseDir, visited, 0);
}

async function expandMemoryImportsAsync(
  content: string,
  baseDir: string,
  visited: Set<string>,
  depth: number
): Promise<string> {
  if (depth >= IMPORT_MAX_DEPTH) return content;

  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const importMatch = line.match(/^@(~\/[^\s`]+|[^\s`]+)\s*$/);
    if (!importMatch) {
      out.push(line);
      continue;
    }

    let importPath = importMatch[1];
    if (importPath.startsWith("~/")) {
      importPath = path.join(os.homedir(), importPath.slice(2));
    } else if (!path.isAbsolute(importPath)) {
      importPath = path.resolve(baseDir, importPath);
    }

    const resolved = path.resolve(importPath);
    if (visited.has(resolved)) {
      out.push(`<!-- skipped circular import ${resolved} -->`);
      continue;
    }

    visited.add(resolved);
    try {
      const buf = await fs.readFile(resolved);
      const imported = stripHtmlComments(buf.toString("utf-8"));
      const expanded = await expandMemoryImportsAsync(
        imported,
        path.dirname(resolved),
        visited,
        depth + 1
      );
      out.push(`<!-- @import ${resolved} -->`, expanded);
    } catch {
      out.push(`<!-- import failed: ${resolved} -->`);
    }
  }

  return out.join("\n");
}

async function listUnconditionalRuleFiles(rulesDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const head = await fs.readFile(full, "utf-8");
          if (!hasPathsFrontmatter(head)) found.push(full);
        } catch {}
      }
    }
  }

  await walk(rulesDir, 0);
  return found.sort().slice(0, RULES_GLOB_MAX);
}

function emptyOmissionCounts(): Record<ProjectMemoryOmissionReason, number> {
  return {
    byte_budget_exhausted: 0,
    empty_after_transform: 0,
    empty_after_limits: 0,
    unreadable: 0,
  };
}

async function appendSection(
  bundle: ProjectMemoryBundle,
  remaining: { value: number },
  maxBytes: number,
  maxLines: number,
  filePath: string,
  kind: ProjectMemorySection["kind"]
): Promise<void> {
  const budget = maxBytes - remaining.value;
  if (budget <= 0) {
    // Budget exhausted: the selected candidate is skipped without reading it
    // just for statistics (§13.2).
    bundle.omitted_sections.push({
      path: filePath,
      kind,
      reason: "byte_budget_exhausted",
      truncation_reasons: [],
    });
    bundle.memory_omitted_counts.byte_budget_exhausted++;
    return;
  }
  const outcome = await readTextLimited(filePath, budget, maxLines, kind);
  if (outcome.section) {
    bundle.sections.push(outcome.section);
    remaining.value += outcome.section.content_bytes;
  } else if (outcome.omission) {
    bundle.omitted_sections.push({ path: filePath, kind, ...outcome.omission });
    bundle.memory_omitted_counts[outcome.omission.reason]++;
  }
}

export async function loadProjectMemory(
  workspaceRoot: string,
  opts?: ProjectMemoryOptions
): Promise<ProjectMemoryBundle> {
  // Resolved independently per key, before any memory file is read.
  const maxLines = resolveLimit("maxLines", opts);
  const maxBytes = resolveLimit("maxBytes", opts);
  const root = path.resolve(workspaceRoot);
  const workspace_roots = opts?.workspaceRoots ?? [root];
  const bundle: ProjectMemoryBundle = {
    root,
    workspace_roots,
    sections: [],
    total_bytes: 0,
    loaded_at: new Date().toISOString(),
    memory_limits: {
      max_lines_per_section: maxLines.value,
      max_content_bytes: maxBytes.value,
    },
    memory_limit_sources: { maxLines: maxLines.source, maxBytes: maxBytes.source },
    memory_omitted_counts: emptyOmissionCounts(),
    omitted_sections: [],
  };
  const remaining = { value: 0 };

  for (const userPath of USER_MEMORY_CANDIDATES) {
    if (!(await fileExists(userPath))) continue;
    await appendSection(bundle, remaining, maxBytes.value, maxLines.value, userPath, "user");
    break;
  }

  for (const rel of ROOT_MEMORY_FILES) {
    const filePath = path.join(root, rel);
    if (!(await fileExists(filePath))) continue;
    await appendSection(bundle, remaining, maxBytes.value, maxLines.value, filePath, "project");
  }

  const rulesDir = path.join(root, ".claude", "rules");
  if (remaining.value < maxBytes.value && (await fileExists(rulesDir))) {
    for (const ruleFile of await listUnconditionalRuleFiles(rulesDir)) {
      await appendSection(bundle, remaining, maxBytes.value, maxLines.value, ruleFile, "rule");
    }
  }

  bundle.total_bytes = remaining.value;
  return bundle;
}

export function formatProjectMemoryForInstructions(bundle: ProjectMemoryBundle): string {
  if (bundle.sections.length === 0) {
    return [
      "## Project memory",
      `No CLAUDE.md or AGENTS.md at ${bundle.root}.`,
      "Create CLAUDE.md in the project root (run /init in Claude Code or write manually).",
      "For another repo: call project_context(path) with the absolute project path.",
      bundle.workspace_roots.length > 1
        ? `Configured workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const blocks = bundle.sections.map((s) => {
    const note = s.truncated ? " (truncated)" : "";
    const label =
      s.kind === "user"
        ? "User memory"
        : s.kind === "rule"
          ? "Rule"
          : s.kind === "import"
            ? "Import"
            : "Project";
    return `### ${label}: ${s.path}${note}\n${s.content}`;
  });

  return [
    "## Project memory (auto-loaded like Claude Code CLAUDE.md)",
    `Primary root: ${bundle.root}`,
    "Treat content below as ground truth for conventions, build commands, and architecture.",
    bundle.workspace_roots.length > 1
      ? `All workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
      : "",
    "",
    ...blocks,
  ]
    .filter(Boolean)
    .join("\n");
}
