/**
 * Skill registry — the cached, filtered view of discovery that the rest of the
 * host talks to.
 *
 * Discovery walks several directory trees, so it runs once at startup and on an
 * explicit `refreshSkills()`. There is deliberately no filesystem watcher: a
 * watcher across six roots is a lot of machinery for a set of files that change
 * on human timescales, and a stale entry is visible and fixable, whereas a
 * watcher that silently dies is not.
 */

import { discoverSkills, type DiscoveredSkill, type DiscoveryResult, type SkillRoot } from "./discover.js";
import { platformId } from "../lib/platform.js";

/** Byte ceiling for the skills block inside MCP instructions. */
export const INSTRUCTION_BYTE_CAP = 12 * 1024;

/** Per-skill description budget in the instruction block. */
const DESCRIPTION_CHARS = 200;

export interface SkillRegistryOptions {
  workspaceRoots: string[];
  extraRoots?: string[];
  /** Allowlist; empty means "all discovered skills". */
  enabled?: string[];
  /** Denylist, applied after the allowlist. */
  disabled?: string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface SkillRegistry {
  skills: DiscoveredSkill[];
  roots: SkillRoot[];
  shadowed: DiscoveryResult["shadowed"];
  /** Discovered but filtered out by `enabled`/`disabled`. */
  filtered: string[];
  loadedAt: string;
}

let cached: SkillRegistry | null = null;
let cachedOptions: SkillRegistryOptions | null = null;

function applyFilters(
  skills: DiscoveredSkill[],
  opts: SkillRegistryOptions
): { kept: DiscoveredSkill[]; filtered: string[] } {
  const enabled = new Set((opts.enabled ?? []).map((s) => s.trim()).filter(Boolean));
  const disabled = new Set((opts.disabled ?? []).map((s) => s.trim()).filter(Boolean));

  const kept: DiscoveredSkill[] = [];
  const filtered: string[] = [];

  for (const skill of skills) {
    if (enabled.size > 0 && !enabled.has(skill.name)) {
      filtered.push(skill.name);
      continue;
    }
    if (disabled.has(skill.name)) {
      filtered.push(skill.name);
      continue;
    }
    kept.push(skill);
  }

  return { kept, filtered };
}

export async function loadSkillRegistry(opts: SkillRegistryOptions): Promise<SkillRegistry> {
  const result = await discoverSkills({
    workspaceRoots: opts.workspaceRoots,
    extraRoots: opts.extraRoots,
    env: opts.env,
    homeDir: opts.homeDir,
  });

  const { kept, filtered } = applyFilters(result.skills, opts);

  cachedOptions = opts;
  cached = {
    skills: kept,
    roots: result.roots,
    shadowed: result.shadowed,
    filtered,
    loadedAt: new Date().toISOString(),
  };
  return cached;
}

export function isSkillRegistryLoaded(): boolean {
  return cached !== null;
}

/** The cached registry, or an empty one if `loadSkillRegistry` never ran. */
export function getSkillRegistry(): SkillRegistry {
  return (
    cached ?? { skills: [], roots: [], shadowed: [], filtered: [], loadedAt: new Date(0).toISOString() }
  );
}

/** Re-run discovery with the options last passed to `loadSkillRegistry`. */
export async function refreshSkills(): Promise<SkillRegistry> {
  if (!cachedOptions) return getSkillRegistry();
  return loadSkillRegistry(cachedOptions);
}

/** Test seam: drop the cache so a fresh process state can be simulated. */
export function resetSkillRegistry(): void {
  cached = null;
  cachedOptions = null;
}

export function findSkill(name: string): DiscoveredSkill | undefined {
  const wanted = name.trim().toLowerCase();
  return getSkillRegistry().skills.find((s) => s.name.toLowerCase() === wanted);
}

/** True when the skill declares no `platforms`, or names the current one. */
export function skillSupportsPlatform(skill: DiscoveredSkill, platform: string = platformId()): boolean {
  const platforms = skill.frontmatter.platforms;
  if (!platforms || platforms.length === 0) return true;
  return platforms.some((p) => p.trim().toLowerCase() === platform.toLowerCase());
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The progressive-disclosure block: name and description only, so the model
 * learns a skill exists without paying for its body. The body arrives on demand
 * through `skill_read`.
 *
 * Entries are emitted until the block would exceed `INSTRUCTION_BYTE_CAP`; the
 * remainder is reported by count rather than silently dropped, because a model
 * that cannot see a skill and cannot see that it is missing will never ask.
 */
export function formatSkillsForInstructions(
  skills: DiscoveredSkill[],
  byteCap: number = INSTRUCTION_BYTE_CAP
): string {
  if (!skills.length) return "";

  const header =
    "## Skills (progressive disclosure — call `skill_read` for the full body before following one)";
  const lines: string[] = [];
  let bytes = Buffer.byteLength(header, "utf-8");
  let emitted = 0;

  for (const skill of skills) {
    const line = `- **${skill.name}**: ${truncate(skill.description, DESCRIPTION_CHARS)}`;
    const lineBytes = Buffer.byteLength(`\n${line}`, "utf-8");

    // Reserve room for the overflow line so the cap holds even when the very
    // next entry is the one that does not fit.
    const remaining = skills.length - emitted;
    const overflow = `\n… and ${remaining} more (use \`skill_list\`)`;
    const overflowBytes = Buffer.byteLength(overflow, "utf-8");

    if (bytes + lineBytes + overflowBytes > byteCap) break;

    lines.push(line);
    bytes += lineBytes;
    emitted++;
  }

  if (emitted < skills.length) {
    lines.push(`… and ${skills.length - emitted} more (use \`skill_list\`)`);
  }

  return [header, ...lines].join("\n");
}
