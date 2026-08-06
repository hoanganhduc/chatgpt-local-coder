/**
 * Skill discovery across every root this host understands.
 *
 * Roots are searched in a fixed precedence order and the first root to define a
 * given skill `name` wins. That makes a project-local skill override a global
 * one of the same name, which is what every other agent host in this family
 * does, and it means a user can shadow a canonical skill without editing the
 * canonical repo.
 *
 * Names are compared without regard to case, matching how `findSkill` resolves
 * one: `Zotero` and `zotero` are the same skill, so one shadows the other
 * rather than both being listed.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseSkillFile, type SkillFrontmatter } from "./frontmatter.js";

/** How deep below a root we look for `SKILL.md`. */
const MAX_DEPTH = 3;

export interface SkillRoot {
  path: string;
  /** Where the root came from — surfaced in diagnostics. */
  origin:
    | "workspace-agents"
    | "workspace-claude"
    | "skills-home"
    | "user-claude"
    | "user-host"
    | "user-codex"
    | "canonical"
    | "config";
  /** Lower is higher precedence. */
  rank: number;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. */
  file: string;
  /** Directory containing SKILL.md — the base for `entrypoint` resolution. */
  dir: string;
  root: SkillRoot;
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[];
  roots: SkillRoot[];
  /** Skills dropped because a higher-precedence root already defined the name. */
  shadowed: Array<{ name: string; file: string; shadowedBy: string }>;
}

export interface DiscoverOptions {
  workspaceRoots: string[];
  /** Extra roots from `skills.roots` in host config. */
  extraRoots?: string[];
  /** Overrides `process.env` lookups; used by tests. */
  env?: NodeJS.ProcessEnv;
  /** Overrides `os.homedir()`; used by tests. */
  homeDir?: string;
}

/**
 * Build the candidate root list in precedence order. Roots that do not exist on
 * disk are still returned — `discoverSkills` skips them, and reporting them is
 * useful in `doctor` output.
 */
export function skillRootCandidates(opts: DiscoverOptions): SkillRoot[] {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? os.homedir();
  const roots: SkillRoot[] = [];
  let rank = 0;

  const push = (p: string | undefined, origin: SkillRoot["origin"]) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (roots.some((r) => r.path === resolved)) return;
    roots.push({ path: resolved, origin, rank: rank++ });
  };

  for (const ws of opts.workspaceRoots) push(path.join(ws, ".agents", "skills"), "workspace-agents");
  for (const ws of opts.workspaceRoots) push(path.join(ws, ".claude", "skills"), "workspace-claude");

  push(env.AI_AGENTS_SKILLS_HOME?.trim() || undefined, "skills-home");
  push(path.join(home, ".claude", "skills"), "user-claude");
  // This host's own home, the directory `ai-agents-skills` installs into when
  // the `chatgpt-local-coder` target is selected.
  push(path.join(home, ".chatgpt-local-coder", "skills"), "user-host");
  push(path.join(home, ".codex", "skills"), "user-codex");
  push(path.join(home, "ai-agents-skills", "canonical", "skills"), "canonical");

  for (const extra of opts.extraRoots ?? []) push(extra, "config");

  return roots;
}

async function readSkill(file: string, root: SkillRoot, fallbackName: string): Promise<DiscoveredSkill | null> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseSkillFile(content);
  const name = (frontmatter.name || fallbackName).trim();
  if (!name) return null;

  const description =
    frontmatter.description?.trim() ||
    body
      .split("\n")
      .find((line) => line.trim() && !line.trimStart().startsWith("#"))
      ?.trim() ||
    name;

  return { name, description, file, dir: path.dirname(file), root, frontmatter, body };
}

async function collectFromRoot(root: SkillRoot): Promise<DiscoveredSkill[]> {
  const found: DiscoveredSkill[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

      const full = path.join(dir, entry.name);
      const skillFile = path.join(full, "SKILL.md");

      let hasSkillFile = false;
      try {
        hasSkillFile = (await fs.stat(skillFile)).isFile();
      } catch {
        hasSkillFile = false;
      }

      if (hasSkillFile) {
        const skill = await readSkill(skillFile, root, entry.name);
        if (skill) found.push(skill);
        // A skill directory is a leaf: nested SKILL.md files below it are
        // supporting material, not separate skills.
        continue;
      }

      await walk(full, depth + 1);
    }
  }

  await walk(root.path, 0);
  return found;
}

export async function discoverSkills(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const roots = skillRootCandidates(opts);
  const byName = new Map<string, DiscoveredSkill>();
  const shadowed: DiscoveryResult["shadowed"] = [];

  for (const root of roots) {
    const skills = await collectFromRoot(root);
    // Sort within a root so two same-named skills under one root resolve
    // deterministically rather than by readdir order.
    skills.sort((a, b) => a.file.localeCompare(b.file));

    for (const skill of skills) {
      // Keyed folded, displayed as written. `findSkill` has always compared
      // lowercased, so `zotero` and `Zotero` were one skill at lookup time and
      // two here: both survived discovery, `skill_list` advertised both, and
      // whichever sorted first answered for both names while the other could
      // not be reached at all. Folding the key moves that collision to where it
      // is visible — the loser is now reported in `shadowed` like any other.
      const key = skill.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        shadowed.push({ name: skill.name, file: skill.file, shadowedBy: existing.file });
        continue;
      }
      byName.set(key, skill);
    }
  }

  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills: list, roots, shadowed };
}
