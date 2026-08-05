/**
 * Settings adapters (T7): source precedence, the asymmetric permission
 * semantics, malformed-file tolerance, and the read-only guarantee.
 *
 * A fake HOME carries all four sources so the assertions never depend on the
 * developer's real Claude/Codex/Grok/OpenCode configuration.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";

import { parseMinimalToml } from "../dist/settings/codex.js";
import { evaluateRules, mergeSettings, parseRule, SOURCE_PRECEDENCE } from "../dist/settings/merge.js";
import { loadSettings, resetSettings, checkImportedRules } from "../dist/settings/index.js";
import {
  setImportedRuleCheck,
  setPermissionContext,
  requireCommandAllowed,
  requirePathAllowed,
} from "../dist/lib/permissions.js";

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
function throws(fn, pattern, what) {
  try { fn(); } catch (e) {
    assert(pattern.test(e.message), `${what}: unexpected message ${e.message}`);
    return;
  }
  throw new Error(`${what}: expected a throw`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-settings-"));
const home = path.join(tmp, "home");
const workspace = path.join(tmp, "workspace");
await fs.mkdir(workspace, { recursive: true });

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf-8");
  return file;
}

// ------------------------------------------------------------------ TOML subset

check("the TOML subset reads scalars, tables, arrays, and quoted key paths", () => {
  const t = parseMinimalToml(
    [
      "# a comment",
      'model = "gpt-5.6-sol"',
      "count = 42",
      "ratio = 0.5",
      "flag = true",
      "",
      "[features]",
      "hooks = true",
      "",
      "[mcp_servers.sequentialThinking]",
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
      "startup_timeout_sec = 20.0",
      "",
      "[mcp_servers.remote]",
      'url = "https://example.test/mcp" # trailing comment',
      "",
      '[projects."/home/ubuntu/my project"]',
      'trust_level = "trusted"',
    ].join("\n")
  );

  assert(t.model === "gpt-5.6-sol", `model: ${t.model}`);
  assert(t.count === 42 && t.ratio === 0.5 && t.flag === true, "scalar types");
  assert(t.features.hooks === true, "nested table");
  assert(t.mcp_servers.sequentialThinking.command === "npx", "table path");
  assert(
    JSON.stringify(t.mcp_servers.sequentialThinking.args) ===
      '["-y","@modelcontextprotocol/server-sequential-thinking"]',
    `args: ${JSON.stringify(t.mcp_servers.sequentialThinking.args)}`
  );
  assert(t.mcp_servers.remote.url === "https://example.test/mcp", `url: ${t.mcp_servers.remote.url}`);
  assert(t.projects["/home/ubuntu/my project"].trust_level === "trusted", "quoted key segment");
});

check("a `#` inside a quoted TOML value is not treated as a comment", () => {
  const t = parseMinimalToml('token = "abc#def"');
  assert(t.token === "abc#def", `token: ${t.token}`);
});

check("dotted keys inside a table nest under that table", () => {
  const t = parseMinimalToml(["[tui]", 'keymap.chat.interrupt_turn = "f12"'].join("\n"));
  assert(t.tui.keymap.chat.interrupt_turn === "f12", `got: ${JSON.stringify(t.tui)}`);
});

// ----------------------------------------------------------------- rule parsing

check("rules parse into tool plus optional pattern", () => {
  assert(parseRule("Bash").tool === "Bash", "bare tool");
  assert(parseRule("Bash").pattern === undefined, "bare tool has no pattern");
  const r = parseRule("Bash(rm -rf /)");
  assert(r.tool === "Bash" && r.pattern === "rm -rf /", `parsed: ${JSON.stringify(r)}`);
  assert(parseRule("   ") === null, "blank rule");
});

check("deny rules match host tool names through their aliases", () => {
  const perms = { deny: ["Bash(rm -rf /)"], ask: [] };
  assert(evaluateRules(perms, "run_command", "rm -rf /")?.decision === "deny", "Bash -> run_command");
  assert(evaluateRules(perms, "start_process", "rm -rf /")?.decision === "deny", "Bash -> start_process");
  assert(evaluateRules(perms, "read_text_file", "rm -rf /") === null, "unrelated tool untouched");
  assert(evaluateRules(perms, "run_command", "ls") === null, "unrelated command untouched");
});

check("a glob deny rule matches across path separators", () => {
  const perms = { deny: ["Edit(/**/.env)"], ask: [] };
  assert(evaluateRules(perms, "write_file", "/home/u/project/.env")?.decision === "deny", "nested path");
  assert(evaluateRules(perms, "write_file", "/.env")?.decision === "deny", "root-level path");
  assert(evaluateRules(perms, "write_file", "C:\\Users\\u\\.env")?.decision === "deny", "windows path");
  assert(evaluateRules(perms, "write_file", "/home/u/.environment") === null, "prefix is not a match");
});

check("a wildcard-free rule also matches the command plus its arguments", () => {
  const perms = { deny: ["Bash(git push --force)"], ask: [] };
  assert(evaluateRules(perms, "run_command", "git push --force")?.decision === "deny", "exact");
  assert(evaluateRules(perms, "run_command", "git push --force origin main")?.decision === "deny", "with args");
  assert(evaluateRules(perms, "run_command", "git push origin main") === null, "different command");
});

check("a bare tool rule denies every invocation of that tool", () => {
  const perms = { deny: ["Bash"], ask: [] };
  assert(evaluateRules(perms, "run_command", "echo hi")?.decision === "deny", "bare rule");
});

check("an imported allow is never returned as a verdict", () => {
  // evaluateRules only ever reports deny or ask — allow cannot widen anything.
  assert(evaluateRules({ deny: [], ask: [] }, "run_command", "anything") === null, "no verdict");
});

// ---------------------------------------------------------------------- fixtures

await write(
  path.join(home, ".claude", "settings.json"),
  JSON.stringify({
    model: "claude-opus-5",
    permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm -rf /)"], ask: ["Bash(git push*)"] },
    mcpServers: { shared: { command: "claude-shared" }, claudeOnly: { command: "c" } },
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo post", timeout: 5 }] }],
    },
  })
);

await write(
  path.join(home, ".claude", "agents", "reviewer.md"),
  '---\nname: reviewer\ndescription: Reviews code\nmodel: opus\n---\n\nBody\n'
);

await write(
  path.join(home, ".codex", "config.toml"),
  [
    'model = "gpt-5.6-sol"',
    "",
    "[mcp_servers.shared]",
    'command = "codex-shared"',
    "",
    "[mcp_servers.codexOnly]",
    'command = "x"',
    'args = ["--flag"]',
  ].join("\n")
);
await write(path.join(home, ".codex", "AGENTS.md"), "# Codex agents\n");

await write(
  path.join(home, ".grok", "settings.json"),
  JSON.stringify({
    model: "grok-4",
    permissions: { deny: ["Bash(curl * | sh)"] },
    mcpServers: { shared: { command: "grok-shared" }, grokOnly: { command: "g" } },
  })
);

await write(
  path.join(home, ".config", "opencode", "opencode.json"),
  JSON.stringify({
    model: "opencode/sonnet",
    mcp: {
      shared: { type: "local", command: ["opencode-shared", "--serve"] },
      remote: { type: "remote", url: "https://example.test/mcp" },
      disabled: { type: "local", command: ["nope"], enabled: false },
    },
    permission: { webfetch: "deny", bash: "ask", edit: "allow" },
    agent: { builder: { description: "Builds", tools: { read: true, write: false } } },
  })
);

const baseOpts = { workspaceRoots: [workspace], homeDir: home, env: {} };

// ---------------------------------------------------------------- precedence

await checkAsync("every source loads and reports its own file path", async () => {
  resetSettings();
  const s = await loadSettings(baseOpts);
  const ids = s.sources.filter((x) => x.ok).map((x) => x.id).sort();
  assert(ids.join(",") === "claude,codex,grok,opencode", `loaded: ${ids.join(",")}`);
  assert(s.sources.every((x) => path.isAbsolute(x.path)), "paths are absolute");
});

await checkAsync("claude outranks opencode, grok, and codex for a shared key", async () => {
  resetSettings();
  const s = await loadSettings(baseOpts);
  assert(s.model === "claude-opus-5", `model: ${s.model}`);
  assert(s.mcpServers.shared.command === "claude-shared", `shared: ${s.mcpServers.shared.command}`);

  const modelConflict = s.conflicts.filter((c) => c.key === "model").pop();
  assert(modelConflict.winner === "claude", `winner: ${modelConflict.winner}`);
  assert(
    modelConflict.losers.join(",") === "codex,grok,opencode",
    `losers: ${modelConflict.losers.join(",")}`
  );
});

check("the declared precedence order is codex < grok < opencode < claude", () => {
  assert(SOURCE_PRECEDENCE.join(",") === "codex,grok,opencode,claude", SOURCE_PRECEDENCE.join(","));
});

await checkAsync("host config outranks every imported source for model", async () => {
  resetSettings();
  const s = await loadSettings({ ...baseOpts, host: { model: "host-model" } });
  assert(s.model === "host-model", `model: ${s.model}`);
  assert(s.conflicts.some((c) => c.key === "model" && c.winner === "host"), "host conflict recorded");
});

await checkAsync("keys unique to a low-precedence source survive the merge", async () => {
  resetSettings();
  const s = await loadSettings(baseOpts);
  assert(s.mcpServers.codexOnly.command === "x", "codex-only server kept");
  assert(JSON.stringify(s.mcpServers.codexOnly.args) === '["--flag"]', "codex args kept");
  assert(s.mcpServers.grokOnly.command === "g", "grok-only server kept");
  assert(s.mcpServers.claudeOnly.command === "c", "claude-only server kept");
});

await checkAsync("opencode local and remote MCP forms both normalize", async () => {
  resetSettings();
  const s = await loadSettings({ ...baseOpts, sources: ["opencode"] });
  assert(s.mcpServers.shared.command === "opencode-shared", `command: ${s.mcpServers.shared.command}`);
  assert(JSON.stringify(s.mcpServers.shared.args) === '["--serve"]', `args: ${JSON.stringify(s.mcpServers.shared.args)}`);
  assert(s.mcpServers.remote.url === "https://example.test/mcp", "remote url");
  assert(!("disabled" in s.mcpServers), "an entry with enabled:false is skipped");
});

await checkAsync("claude agents and hooks are imported", async () => {
  resetSettings();
  const s = await loadSettings(baseOpts);
  assert(s.agents.reviewer.description === "Reviews code", `agent: ${JSON.stringify(s.agents.reviewer)}`);
  assert(s.agents.reviewer.model === "opus", "agent model");
  assert(s.hooks.PostToolUse[0].matcher === "Bash", "hook matcher");
  assert(s.hooks.PostToolUse[0].hooks[0].command === "echo post", "hook command");
  assert(s.hooks.PostToolUse[0].hooks[0].timeoutSec === 5, "hook timeout normalized");
  assert(s.agents["codex-agents-md"], "codex AGENTS.md detected");
  assert(s.agents.builder.tools.join(",") === "read", "opencode tool map -> enabled names only");
});

// ---------------------------------------------------- deny survives higher allow

await checkAsync("a deny from a low-precedence source survives a high-precedence allow", async () => {
  // codex is the lowest-precedence source; claude the highest.
  await write(
    path.join(home, ".grok", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(curl * | sh)"] } })
  );
  await write(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(curl * | sh)", "Bash(rm -rf /)"] } })
  );

  resetSettings();
  const s = await loadSettings(baseOpts);
  assert(s.permissions.deny.includes("Bash(curl * | sh)"), `deny: ${JSON.stringify(s.permissions.deny)}`);
  assert(s.permissions.allow.includes("Bash(curl * | sh)"), "allow also recorded");
  assert(
    evaluateRules(s.permissions, "run_command", "curl https://x | sh")?.decision === "deny",
    "the higher-precedence allow does not cancel the deny"
  );
});

await checkAsync("an OpenCode `permission.edit: deny` becomes a blanket write deny", async () => {
  // OpenCode spells permissions as action -> verdict rather than as rules. A
  // blanket deny there has to reach every write tool here, or the import would
  // look like it worked while enforcing nothing.
  await write(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ permission: { edit: "deny" } })
  );

  resetSettings();
  const s = await loadSettings({ ...baseOpts, sources: ["opencode"] });
  assert(s.permissions.deny.includes("edit"), `deny: ${JSON.stringify(s.permissions.deny)}`);
  assert(evaluateRules(s.permissions, "write_file", "/anything")?.decision === "deny", "write denied");
  assert(evaluateRules(s.permissions, "apply_patch", "/anything")?.decision === "deny", "patch denied");
  assert(evaluateRules(s.permissions, "read_text_file", "/anything") === null, "reads unaffected");

  // Restore the richer fixture for the tests that follow.
  await write(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({
      model: "opencode/sonnet",
      mcp: { shared: { type: "local", command: ["opencode-shared", "--serve"] } },
      permission: { webfetch: "deny" },
    })
  );
});

check("a `*` in a command rule spans slashes; a `*` in a path rule does not", () => {
  assert(
    evaluateRules({ deny: ["Bash(curl * | sh)"], ask: [] }, "run_command", "curl https://x/y | sh")?.decision === "deny",
    "command wildcard crosses slashes"
  );
  assert(
    evaluateRules({ deny: ["Edit(/etc/*)"], ask: [] }, "write_file", "/etc/passwd")?.decision === "deny",
    "path wildcard matches one segment"
  );
  assert(
    evaluateRules({ deny: ["Edit(/etc/*)"], ask: [] }, "write_file", "/etc/nested/file") === null,
    "path wildcard does not cross a separator"
  );
});

check("merged rule lists are unioned rather than overwritten", () => {
  const merged = mergeSettings([
    { id: "codex", statuses: [], permissions: { allow: [], deny: ["A"], ask: [] }, mcpServers: {}, hooks: {}, agents: {}, skillRoots: [] },
    { id: "claude", statuses: [], permissions: { allow: [], deny: ["B"], ask: [] }, mcpServers: {}, hooks: {}, agents: {}, skillRoots: [] },
  ]);
  assert(merged.permissions.deny.join(",") === "A,B", `deny: ${merged.permissions.deny.join(",")}`);
});

// ------------------------------------------------------------- malformed files

await checkAsync("a malformed JSON source yields ok:false with an error, not a throw", async () => {
  await write(path.join(home, ".claude", "settings.json"), "{ this is not json ");

  resetSettings();
  const s = await loadSettings(baseOpts);
  const claude = s.sources.find((x) => x.path.endsWith(path.join(".claude", "settings.json")));
  assert(claude, "claude source reported");
  assert(claude.ok === false, "reported as failed");
  assert(typeof claude.error === "string" && claude.error.length > 0, `error: ${claude.error}`);

  // The other sources still merged.
  assert(s.mcpServers.codexOnly, "codex still imported");
  assert(s.model === "gpt-5.6-sol" || s.model === "opencode/sonnet" || s.model === "grok-4",
    `a surviving source still supplied the model: ${s.model}`);
});

await checkAsync("an absent source is silently skipped rather than reported as broken", async () => {
  resetSettings();
  const s = await loadSettings({ workspaceRoots: [workspace], homeDir: path.join(tmp, "no-such-home"), env: {} });
  assert(s.sources.length === 0, `sources: ${JSON.stringify(s.sources)}`);
  assert(s.permissions.deny.length === 0, "no rules");
});

await checkAsync("settings.import = false skips every source", async () => {
  resetSettings();
  const s = await loadSettings({ ...baseOpts, enabled: false });
  assert(s.sources.length === 0 && !s.model, "nothing imported");
});

// ------------------------------------------------------------ read-only sources

await checkAsync("loading settings does not modify any source file", async () => {
  const files = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".codex", "config.toml"),
    path.join(home, ".grok", "settings.json"),
    path.join(home, ".config", "opencode", "opencode.json"),
  ];
  const before = await Promise.all(files.map((f) => fs.readFile(f, "utf-8")));

  resetSettings();
  await loadSettings(baseOpts);

  const after = await Promise.all(files.map((f) => fs.readFile(f, "utf-8")));
  for (let i = 0; i < files.length; i++) {
    assert(before[i] === after[i], `${files[i]} was modified`);
  }
});

// ------------------------------------------------------- enforcement chokepoints

await checkAsync("an imported deny blocks run_command through the permission engine", async () => {
  await write(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)", "Edit(/**/.env)"] } })
  );

  resetSettings();
  await loadSettings(baseOpts);
  setImportedRuleCheck(checkImportedRules);
  setPermissionContext({ profile: "open", roots: [workspace] });

  try {
    throws(() => requireCommandAllowed("rm -rf /"), /imported rule: Bash\(rm -rf \/\)/, "denied command");
    requireCommandAllowed("ls -la"); // must not throw
    ok("an unrelated command is unaffected");
  } finally {
    setImportedRuleCheck(null);
  }
});

await checkAsync("an imported deny blocks a write even under the open profile", async () => {
  resetSettings();
  await loadSettings(baseOpts);
  setImportedRuleCheck(checkImportedRules);
  // `open` permits any path, so a throw here can only come from the imported rule.
  setPermissionContext({ profile: "open", roots: [workspace] });

  try {
    throws(
      () => requirePathAllowed(path.join(workspace, ".env"), "write"),
      /imported rule: Edit\(\/\*\*\/\.env\)/,
      "denied write"
    );
    requirePathAllowed(path.join(workspace, "src.ts"), "write"); // must not throw
    ok("an unrelated write is unaffected");
  } finally {
    setImportedRuleCheck(null);
  }
});

await checkAsync("an imported allow cannot widen the workspace profile", async () => {
  await write(
    path.join(home, ".claude", "settings.json"),
    // An allow naming a path outside the workspace must not grant a write there.
    JSON.stringify({ permissions: { allow: ["Edit(/**)", "Bash"], deny: [] } })
  );

  resetSettings();
  await loadSettings(baseOpts);
  setImportedRuleCheck(checkImportedRules);
  setPermissionContext({ profile: "workspace", roots: [workspace] });

  try {
    const outside = path.join(tmp, "outside.txt");
    throws(() => requirePathAllowed(outside, "write"), /outside workspace roots/, "still bounded");
  } finally {
    setImportedRuleCheck(null);
    setPermissionContext({ profile: "workspace", roots: [process.cwd()] });
  }
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
