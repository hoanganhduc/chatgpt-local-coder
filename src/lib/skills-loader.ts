/**
 * Thin compatibility layer over the skills engine in `src/skills/`.
 *
 * Callers that only need the instruction summary keep using these two
 * functions; discovery, filtering, and execution live in the engine.
 */

import { discoverSkills } from "../skills/discover.js";
import { formatSkillsForInstructions as formatDiscovered } from "../skills/registry.js";
import type { DiscoveredSkill } from "../skills/discover.js";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const { skills } = await discoverSkills({ workspaceRoots: [workspaceRoot] });
  return skills.map((s) => ({ name: s.name, description: s.description, path: s.file }));
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  // The engine formats `DiscoveredSkill`, but only `name` and `description` are
  // read for the summary block, so the summary shape is sufficient here.
  return formatDiscovered(skills as unknown as DiscoveredSkill[]);
}
