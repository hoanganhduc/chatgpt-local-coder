/**
 * Skills engine (T6): discovery precedence, frontmatter round-trip, the
 * instruction byte cap, platform refusal, and execution.
 *
 * Discovery reads `$AI_AGENTS_SKILLS_HOME` and the user's home directory, so
 * both are redirected at a temp tree — otherwise the assertions would depend on
 * whatever skills the developer happens to have installed.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";

import { parseSkillFile } from "../dist/skills/frontmatter.js";
import { discoverSkills, skillRootCandidates } from "../dist/skills/discover.js";
import {
  formatSkillsForInstructions,
  loadSkillRegistry,
  resetSkillRegistry,
  findSkill,
  skillSupportsPlatform,
} from "../dist/skills/registry.js";
import { runSkill, isSkillRuntime } from "../dist/skills/run.js";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
function check(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-skills-"));
const fakeHome = path.join(tmp, "home");
const workspace = path.join(tmp, "workspace");
const emptyEnv = { AI_AGENTS_SKILLS_HOME: "" };

async function writeSkill(dir, name, frontmatter, body = "Body of " + name) {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf-8");
  return skillDir;
}

// ---------------------------------------------------------------- frontmatter

check("frontmatter parses scalars, inline lists, block lists, and nesting", () => {
  const parsed = parseSkillFile(
    [
      "---",
      "name: demo",
      "description: A demo skill",
      "allowed-tools: [read_text_file, grep]",
      "platforms:",
      "  - linux",
      "  - darwin",
      "runtime: node",
      "entrypoint: run.mjs",
      "context: fork",
      "model: opus",
      "agent: claude",
      "license: MIT",
      "metadata:",
      "  short-description: short",
      "  version: 3",
      "---",
      "",
      "# Demo",
      "",
      "Instructions here.",
    ].join("\n")
  );

  const fm = parsed.frontmatter;
  assert(fm.name === "demo", `name: ${fm.name}`);
  assert(fm.description === "A demo skill", `description: ${fm.description}`);
  assert(JSON.stringify(fm.allowedTools) === '["read_text_file","grep"]', `allowed-tools: ${JSON.stringify(fm.allowedTools)}`);
  assert(JSON.stringify(fm.platforms) === '["linux","darwin"]', `platforms: ${JSON.stringify(fm.platforms)}`);
  assert(fm.runtime === "node" && fm.entrypoint === "run.mjs", "runtime/entrypoint");
  assert(fm.context === "fork" && fm.model === "opus" && fm.agent === "claude", "context/model/agent");
  assert(fm.license === "MIT", "license");
  assert(fm.metadata?.["short-description"] === "short", `metadata: ${JSON.stringify(fm.metadata)}`);
  assert(fm.metadata?.version === 3, "metadata numeric scalar");
  assert(parsed.body.includes("Instructions here."), "body retained");
  assert(!parsed.body.includes("name: demo"), "frontmatter stripped from body");
});

check("frontmatter retains unknown keys verbatim in raw", () => {
  const { frontmatter } = parseSkillFile(
    ["---", "name: keep", "x-custom-field: preserved", "unknown-list:", "  - one", "  - two", "---", "", "body"].join("\n")
  );
  assert(frontmatter.raw["x-custom-field"] === "preserved", `x-custom-field: ${frontmatter.raw["x-custom-field"]}`);
  assert(
    JSON.stringify(frontmatter.raw["unknown-list"]) === '["one","two"]',
    `unknown-list: ${JSON.stringify(frontmatter.raw["unknown-list"])}`
  );
  assert(frontmatter.raw.name === "keep", "known keys still in raw");
});

check("a file with no frontmatter yields an empty raw and an intact body", () => {
  const parsed = parseSkillFile("# Just a heading\n\ntext\n");
  assert(parsed.hadFrontmatter === false, "hadFrontmatter");
  assert(Object.keys(parsed.frontmatter.raw).length === 0, "raw is empty");
  assert(parsed.body.startsWith("# Just a heading"), "body intact");
});

// ------------------------------------------------------------------ discovery

const wsAgents = path.join(workspace, ".agents", "skills");
const wsClaude = path.join(workspace, ".claude", "skills");
const homeClaude = path.join(fakeHome, ".claude", "skills");

await writeSkill(wsAgents, "shared", "name: shared\ndescription: from .agents (highest precedence)");
await writeSkill(wsClaude, "shared", "name: shared\ndescription: from .claude (shadowed)");
await writeSkill(wsClaude, "only-claude", "name: only-claude\ndescription: workspace claude only");
await writeSkill(homeClaude, "shared", "name: shared\ndescription: from home (shadowed)");
await writeSkill(homeClaude, "home-only", "name: home-only\ndescription: user-level skill");
// Nested one level down, to prove the walk descends into category directories.
await writeSkill(path.join(homeClaude, "category"), "nested", "name: nested\ndescription: nested skill");

const discoverOpts = { workspaceRoots: [workspace], homeDir: fakeHome, env: emptyEnv };

await checkAsync("root candidates are ordered .agents < .claude < home", async () => {
  const roots = skillRootCandidates(discoverOpts);
  const origins = roots.map((r) => r.origin);
  assert(origins[0] === "workspace-agents", `first: ${origins[0]}`);
  assert(origins[1] === "workspace-claude", `second: ${origins[1]}`);
  assert(origins.includes("user-claude"), "user-claude present");
  assert(origins.includes("canonical"), "canonical present");
  assert(roots.every((r, i) => r.rank === i), "ranks are dense and ordered");
});

await checkAsync("the host's own install home is a root, ranked after ~/.claude", () => {
  const roots = skillRootCandidates(discoverOpts);
  const host = roots.find((r) => r.origin === "user-host");
  assert(host, "user-host root present");
  assert(
    host.path === path.join(fakeHome, ".chatgpt-local-coder", "skills"),
    `path: ${host.path}`
  );
  // ai-agents-skills installs here; a user-level Claude skill of the same name
  // still wins, and this root still outranks ~/.codex and the canonical repo.
  const rank = (origin) => roots.findIndex((r) => r.origin === origin);
  assert(rank("user-claude") < host.rank, "ranked below ~/.claude/skills");
  assert(host.rank < rank("user-codex"), "ranked above ~/.codex/skills");
  assert(host.rank < rank("canonical"), "ranked above the canonical repo");
});

await checkAsync("the highest-precedence root wins a duplicate name", async () => {
  const { skills, shadowed } = await discoverSkills(discoverOpts);
  const shared = skills.find((s) => s.name === "shared");
  assert(shared, "shared skill discovered");
  assert(shared.description.includes(".agents"), `won by: ${shared.description}`);
  assert(shared.root.origin === "workspace-agents", `origin: ${shared.root.origin}`);
  assert(skills.filter((s) => s.name === "shared").length === 1, "no duplicate entries");
  assert(shadowed.filter((s) => s.name === "shared").length === 2, `shadowed: ${shadowed.length}`);
});

// Discovery keyed the exact name while `findSkill` compared lowercased, so
// `Zotero` and `zotero` both survived as separate entries and `skill_list`
// advertised both — but every lookup of either name reached whichever sorted
// first, leaving the other listed and unreachable. The collision belongs in
// `shadowed`, where a user can see which copy lost.
await checkAsync("two skills differing only in case collapse to one, and the loser is reported", async () => {
  // Its own tree: the shared fixtures above assert an exact name list, and a
  // case variant added there would change it.
  const caseTmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-skills-case-"));
  const caseWs = path.join(caseTmp, "workspace");
  const caseHome = path.join(caseTmp, "home");
  await writeSkill(path.join(caseWs, ".agents", "skills"), "Zotero", "name: Zotero\ndescription: capitalised, workspace");
  await writeSkill(path.join(caseHome, ".claude", "skills"), "zotero", "name: zotero\ndescription: lowercase, home");

  const opts = { workspaceRoots: [caseWs], homeDir: caseHome, env: emptyEnv };
  const { skills, shadowed } = await discoverSkills(opts);

  const matches = skills.filter((s) => s.name.toLowerCase() === "zotero");
  assert(matches.length === 1, `expected one entry, got ${matches.map((s) => s.name).join(",")}`);
  // Folded for the key, kept as written for display: a skill named `Zotero`
  // must not be listed as `zotero`.
  assert(matches[0].name === "Zotero", `display name: ${matches[0].name}`);
  assert(matches[0].root.origin === "workspace-agents", `origin: ${matches[0].root.origin}`);
  assert(
    shadowed.some((s) => s.name === "zotero" && s.shadowedBy === matches[0].file),
    `shadowed: ${JSON.stringify(shadowed)}`
  );

  resetSkillRegistry();
  await loadSkillRegistry(opts);
  for (const spelling of ["Zotero", "zotero", "ZOTERO"]) {
    assert(findSkill(spelling)?.file === matches[0].file, `findSkill(${spelling}) missed the surviving copy`);
  }

  resetSkillRegistry();
  await fs.rm(caseTmp, { recursive: true, force: true });
});

await checkAsync("skills from every root are merged, including nested directories", async () => {
  const { skills } = await discoverSkills(discoverOpts);
  const names = skills.map((s) => s.name).sort();
  assert(names.includes("only-claude"), "workspace .claude skill");
  assert(names.includes("home-only"), "home skill");
  assert(names.includes("nested"), "nested skill");
  assert(names.join(",") === "home-only,nested,only-claude,shared", `names: ${names.join(",")}`);
});

await checkAsync("AI_AGENTS_SKILLS_HOME outranks the user home roots", async () => {
  const skillsHome = path.join(tmp, "skills-home");
  await writeSkill(skillsHome, "home-only", "name: home-only\ndescription: from AI_AGENTS_SKILLS_HOME");
  const { skills } = await discoverSkills({
    ...discoverOpts,
    env: { AI_AGENTS_SKILLS_HOME: skillsHome },
  });
  const found = skills.find((s) => s.name === "home-only");
  assert(found.root.origin === "skills-home", `origin: ${found.root.origin}`);
});

await checkAsync("a skill with no description falls back to the first body line", async () => {
  const root = path.join(tmp, "nodesc");
  await writeSkill(root, "bare", "name: bare", "# Heading\n\nFirst real line.");
  const { skills } = await discoverSkills({
    workspaceRoots: [],
    extraRoots: [root],
    homeDir: path.join(tmp, "nonexistent-home"),
    env: emptyEnv,
  });
  assert(skills[0].description === "First real line.", `description: ${skills[0].description}`);
});

// ------------------------------------------------------------------- registry

await checkAsync("the disabled list removes a skill from the registry", async () => {
  resetSkillRegistry();
  const registry = await loadSkillRegistry({ ...discoverOpts, disabled: ["home-only"] });
  assert(!registry.skills.some((s) => s.name === "home-only"), "home-only removed");
  assert(registry.filtered.includes("home-only"), "reported as filtered");
  assert(registry.skills.some((s) => s.name === "shared"), "others kept");
});

await checkAsync("the enabled list acts as an allowlist", async () => {
  resetSkillRegistry();
  const registry = await loadSkillRegistry({ ...discoverOpts, enabled: ["shared"] });
  assert(registry.skills.length === 1 && registry.skills[0].name === "shared", `kept: ${registry.skills.map((s) => s.name)}`);
});

await checkAsync("findSkill matches case-insensitively against the loaded registry", async () => {
  resetSkillRegistry();
  await loadSkillRegistry(discoverOpts);
  assert(findSkill("SHARED")?.name === "shared", "case-insensitive lookup");
  assert(findSkill("does-not-exist") === undefined, "unknown name yields undefined");
});

// -------------------------------------------------------------- byte-cap block

check("the instruction block lists every skill when it fits", () => {
  const skills = [
    { name: "alpha", description: "first skill" },
    { name: "beta", description: "second skill" },
  ];
  const block = formatSkillsForInstructions(skills);
  assert(block.includes("**alpha**") && block.includes("**beta**"), "both listed");
  assert(!block.includes("and 0 more"), "no spurious overflow line");
  assert(!block.includes("more (use"), `unexpected overflow: ${block}`);
});

check("the byte cap truncates the list and reports the remainder", () => {
  const skills = Array.from({ length: 400 }, (_, i) => ({
    name: `skill-${String(i).padStart(3, "0")}`,
    description: "x".repeat(200),
  }));
  const block = formatSkillsForInstructions(skills);
  const bytes = Buffer.byteLength(block, "utf-8");

  assert(bytes <= 12 * 1024, `block is ${bytes} bytes, over the 12KB cap`);
  const overflow = block.match(/… and (\d+) more \(use `skill_list`\)/);
  assert(overflow, `overflow line missing from:\n${block.slice(-200)}`);

  const listed = (block.match(/^- \*\*/gm) || []).length;
  assert(listed > 0, "at least one skill listed");
  assert(
    listed + Number(overflow[1]) === 400,
    `listed ${listed} + overflow ${overflow[1]} !== 400`
  );
});

check("descriptions are truncated to 200 characters", () => {
  const block = formatSkillsForInstructions([{ name: "long", description: "y".repeat(500) }]);
  const line = block.split("\n").find((l) => l.startsWith("- **long**"));
  const description = line.slice("- **long**: ".length);
  assert(description.length === 200, `description length ${description.length}`);
  assert(description.endsWith("…"), "truncation marker present");
});

// ------------------------------------------------------- platform enforcement

check("a linux-only skill is refused on a simulated win32 host", () => {
  const skill = { frontmatter: { platforms: ["linux"] } };
  assert(skillSupportsPlatform(skill, "linux") === true, "allowed on linux");
  assert(skillSupportsPlatform(skill, "win32") === false, "refused on win32");
  assert(skillSupportsPlatform(skill, "darwin") === false, "refused on darwin");
});

check("a skill with no platforms runs everywhere", () => {
  const skill = { frontmatter: {} };
  for (const p of ["linux", "win32", "darwin"]) {
    assert(skillSupportsPlatform(skill, p) === true, `should allow ${p}`);
  }
});

check("the runtime allowlist rejects anything outside the five known values", () => {
  for (const good of ["node", "python", "bash", "powershell", "none"]) {
    assert(isSkillRuntime(good) === true, `${good} should be accepted`);
  }
  for (const bad of ["ruby", "deno", "", undefined, "NODE"]) {
    assert(isSkillRuntime(bad) === false, `${bad} should be rejected`);
  }
});

// ------------------------------------------------------------------ execution

const execRoot = path.join(tmp, "exec");
const echoDir = await writeSkill(
  execRoot,
  "echo-skill",
  "name: echo-skill\ndescription: prints its arguments\nruntime: node\nentrypoint: run.mjs"
);
await fs.writeFile(
  path.join(echoDir, "run.mjs"),
  'process.stdout.write("skill-output:" + process.argv.slice(2).join("|"));\n',
  "utf-8"
);

await writeSkill(
  execRoot,
  "linux-only",
  "name: linux-only\ndescription: linux only\nruntime: node\nentrypoint: run.mjs\nplatforms:\n  - linux"
);
await fs.writeFile(path.join(execRoot, "linux-only", "run.mjs"), 'process.stdout.write("ran");\n', "utf-8");

await writeSkill(execRoot, "doc-only", "name: doc-only\ndescription: documentation with no entrypoint");

const escapeDir = await writeSkill(
  execRoot,
  "escape",
  "name: escape\ndescription: entrypoint escapes its directory\nruntime: node\nentrypoint: ../echo-skill/run.mjs"
);

resetSkillRegistry();
await loadSkillRegistry({ workspaceRoots: [], extraRoots: [execRoot], homeDir: path.join(tmp, "nonexistent-home"), env: emptyEnv });

await checkAsync("skill_run returns the entrypoint's stdout", async () => {
  const result = await runSkill("echo-skill", { args: ["a", "b"], timeoutSec: 30 });
  assert(result.exitCode === 0, `exit ${result.exitCode}: ${result.stderr}`);
  assert(result.stdout === "skill-output:a|b", `stdout: ${JSON.stringify(result.stdout)}`);
  assert(result.runtime === "node", `runtime: ${result.runtime}`);
});

await checkAsync("skill_run refuses a linux-only skill on a simulated win32 host", async () => {
  await runSkill("linux-only", { platform: "win32", timeoutSec: 30 }).then(
    () => { throw new Error("should have been refused"); },
    (e) => {
      assert(/does not support platform "win32"/.test(e.message), `message: ${e.message}`);
      assert(e.message.includes("linux"), "message names the declared platforms");
    }
  );
});

await checkAsync("skill_run refuses a documentation-only skill and points at skill_read", async () => {
  await runSkill("doc-only", { timeoutSec: 30 }).then(
    () => { throw new Error("should have been refused"); },
    (e) => {
      assert(/documentation only/.test(e.message), `message: ${e.message}`);
      assert(/skill_read/.test(e.message), "message names skill_read");
    }
  );
});

await checkAsync("skill_run refuses an unrecognised runtime", async () => {
  await writeSkill(execRoot, "ruby-skill", "name: ruby-skill\ndescription: unsupported runtime\nruntime: ruby\nentrypoint: run.rb");
  resetSkillRegistry();
  await loadSkillRegistry({ workspaceRoots: [], extraRoots: [execRoot], homeDir: path.join(tmp, "nonexistent-home"), env: emptyEnv });

  await runSkill("ruby-skill", { timeoutSec: 30 }).then(
    () => { throw new Error("should have been refused"); },
    (e) => assert(/declares runtime "ruby"; expected one of/.test(e.message), `message: ${e.message}`)
  );
});

await checkAsync("an entrypoint outside the skill directory is refused", async () => {
  await runSkill("escape", { timeoutSec: 30 }).then(
    () => { throw new Error("should have been refused"); },
    (e) => assert(/resolves outside its own directory/.test(e.message), `message: ${e.message}`)
  );
});

await checkAsync("allowExecution=false blocks execution entirely", async () => {
  await runSkill("echo-skill", { allowExecution: false, timeoutSec: 30 }).then(
    () => { throw new Error("should have been refused"); },
    (e) => assert(/skill execution is disabled/.test(e.message), `message: ${e.message}`)
  );
});

await checkAsync("an unknown skill name is refused with a pointer to skill_list", async () => {
  await runSkill("no-such-skill", { timeoutSec: 30 }).then(
    () => { throw new Error("should have been refused"); },
    (e) => assert(/not found — call skill_list/.test(e.message), `message: ${e.message}`)
  );
});

await checkAsync("a bash skill on a simulated win32 host names Git Bash or WSL", async () => {
  const bashDir = await writeSkill(
    execRoot,
    "bash-skill",
    "name: bash-skill\ndescription: bash entrypoint\nruntime: bash\nentrypoint: run.sh"
  );
  await fs.writeFile(path.join(bashDir, "run.sh"), 'echo "from bash"\n', "utf-8");

  resetSkillRegistry();
  await loadSkillRegistry({ workspaceRoots: [], extraRoots: [execRoot], homeDir: path.join(tmp, "nonexistent-home"), env: emptyEnv });

  // With bash present the run succeeds; the Windows-without-bash message is
  // asserted directly against the interpreter resolver below.
  const result = await runSkill("bash-skill", { timeoutSec: 30 });
  assert(result.stdout.trim() === "from bash", `stdout: ${JSON.stringify(result.stdout)}`);

  const savedPath = process.env.PATH;
  process.env.PATH = path.join(tmp, "empty-path");
  try {
    await runSkill("bash-skill", { platform: "win32", timeoutSec: 30 }).then(
      () => { throw new Error("should have been refused"); },
      (e) =>
        assert(
          e.message === 'skill "bash-skill" requires bash; install Git Bash or run under WSL',
          `message: ${e.message}`
        )
    );
  } finally {
    process.env.PATH = savedPath;
  }
});

await checkAsync("skill_run reports a timeout rather than hanging", async () => {
  const slowDir = await writeSkill(
    execRoot,
    "slow-skill",
    "name: slow-skill\ndescription: sleeps\nruntime: node\nentrypoint: run.mjs"
  );
  await fs.writeFile(path.join(slowDir, "run.mjs"), "setTimeout(() => {}, 30000);\n", "utf-8");

  resetSkillRegistry();
  await loadSkillRegistry({ workspaceRoots: [], extraRoots: [execRoot], homeDir: path.join(tmp, "nonexistent-home"), env: emptyEnv });

  const result = await runSkill("slow-skill", { timeoutSec: 1 });
  assert(result.timedOut === true, "timedOut flag set");
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
