/**
 * Hooks engine (T9): matcher selection, a blocking PreToolUse, a failing
 * PostToolUse that does not block, the per-call budget, and the post-edit
 * behaviour that used to be called directly from the filesystem tools.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  HOOK_BUDGET_MS,
  clearInternalHooks,
  getHookConfig,
  hasHooks,
  registerInternalHook,
  resetHooks,
  runHooks,
  setHookConfig,
} from "../dist/hooks/engine.js";
import { matchesTool, resetMatcherCache } from "../dist/hooks/matchers.js";
import { applyHookWrapper } from "../dist/hooks/wrap.js";
import { registerPostEditHook } from "../dist/lib/post-edit-hooks.js";
import { toolResult } from "../dist/lib/tool-result.js";
import { setPermissionContext } from "../dist/lib/permissions.js";
import { setDefaultCwd } from "../dist/lib/path-security.js";

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-hooks-"));
setPermissionContext({ profile: "open", roots: [tmp] });
setDefaultCwd(tmp);

/** A hook command that works on every supported shell. */
const isWindows = process.platform === "win32";
const okCmd = isWindows ? "exit 0" : "exit 0";
const failCmd = isWindows ? "Write-Error 'nope'; exit 1" : "echo nope 1>&2; exit 1";
const sleepCmd = isWindows ? "Start-Sleep -Seconds 5" : "sleep 5";

/** A minimal stand-in for McpServer that records what was registered. */
function fakeServer() {
  const tools = new Map();
  const server = {
    registerTool(name, config, callback) {
      tools.set(name, { config, callback });
      return { name };
    },
  };
  return {
    server,
    call: (name, args) => tools.get(name).callback(args, { sessionId: "s1" }),
    has: (name) => tools.has(name),
  };
}

// -------------------------------------------------------------------- matchers

check("a matcher is a regex over the tool name", () => {
  resetMatcherCache();
  assert(matchesTool("write_file", "write_file"), "exact");
  assert(matchesTool("write_file|edit_file", "edit_file"), "alternation");
  assert(matchesTool("Bash", "bash"), "case-insensitive");
  assert(!matchesTool("write_file", "read_text_file"), "non-match");
  assert(!matchesTool("write", "write_file"), "anchored, not a prefix");
});

check("an absent, empty, or `*` matcher fires on every tool", () => {
  assert(matchesTool(undefined, "anything"), "absent");
  assert(matchesTool("", "anything"), "empty");
  assert(matchesTool("*", "anything"), "star");
});

check("an invalid regex matcher degrades to a literal name", () => {
  resetMatcherCache();
  assert(matchesTool("write_file(", "write_file("), "literal match");
  assert(!matchesTool("write_file(", "write_file"), "does not fire elsewhere");
});

// ------------------------------------------------------------------ short-circuit

check("with nothing configured no event has hooks", () => {
  resetHooks();
  assert(!hasHooks("PreToolUse", "write_file"), "pre");
  assert(!hasHooks("PostToolUse", "write_file"), "post");
  assert(!hasHooks("SessionStart"), "session");
});

check("hooks.enabled = false silences every hook", () => {
  resetHooks();
  setHookConfig({
    enabled: false,
    matchers: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: okCmd }] }] },
  });
  assert(!hasHooks("PreToolUse", "write_file"), "disabled");
  assert(getHookConfig().enabled === false, "config reports it");
});

// ------------------------------------------------------------- matcher selection

await checkAsync("only hooks whose matcher fits the tool run", async () => {
  resetHooks();
  const ran = [];
  registerInternalHook("PostToolUse", {
    name: "writes-only",
    matcher: "write_file|edit_file",
    run: async (ctx) => { ran.push(ctx.tool); return undefined; },
  });

  await runHooks({ event: "PostToolUse", tool: "read_text_file" });
  assert(ran.length === 0, `unexpected run: ${ran.join(",")}`);

  await runHooks({ event: "PostToolUse", tool: "edit_file" });
  assert(ran.join(",") === "edit_file", `ran: ${ran.join(",")}`);
});

await checkAsync("a command hook receives the event and tool name in its environment", async () => {
  resetHooks();
  const probe = path.join(tmp, "env.txt");
  const command = isWindows
    ? `"$env:CLC_HOOK_EVENT/$env:CLC_TOOL_NAME" | Out-File -Encoding utf8 '${probe}'`
    : `printf '%s' "$CLC_HOOK_EVENT/$CLC_TOOL_NAME" > '${probe}'`;

  setHookConfig({ enabled: true, matchers: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] } });
  const report = await runHooks({ event: "PostToolUse", tool: "write_file" });
  assert(report.results.length === 1, `results: ${report.results.length}`);

  const seen = (await fs.readFile(probe, "utf-8")).replace(/^﻿/, "").trim();
  assert(seen === "PostToolUse/write_file", `env: ${JSON.stringify(seen)}`);
});

// --------------------------------------------------------------------- blocking

await checkAsync("a failing PreToolUse command hook blocks the call", async () => {
  resetHooks();
  setHookConfig({
    enabled: true,
    matchers: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: failCmd }] }] },
  });

  const report = await runHooks({ event: "PreToolUse", tool: "write_file" });
  assert(report.blocked, "blocked");
  assert(/nope/.test(report.blocked.reason), `reason: ${report.blocked.reason}`);
});

await checkAsync("a failing PostToolUse command hook does not block", async () => {
  resetHooks();
  setHookConfig({
    enabled: true,
    matchers: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: failCmd }] }] },
  });

  const report = await runHooks({ event: "PostToolUse", tool: "write_file" });
  assert(!report.blocked, "not blocked");
  assert(report.results[0].exitCode === 1, `exit: ${report.results[0].exitCode}`);
});

await checkAsync("only PreToolUse can block — a failing Stop hook is just reported", async () => {
  resetHooks();
  setHookConfig({
    enabled: true,
    matchers: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: failCmd }] }] },
  });

  const report = await runHooks({ event: "Stop", sessionId: "s1" });
  assert(!report.blocked, "not blocked");
  assert(report.results.length === 1, `results: ${report.results.length}`);
});

await checkAsync("a hook the permission profile forbids is reported, not treated as a block", async () => {
  resetHooks();
  setPermissionContext({ profile: "readonly", roots: [tmp] });
  setHookConfig({
    enabled: true,
    matchers: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: okCmd }] }] },
  });

  try {
    const report = await runHooks({ event: "PreToolUse", tool: "read_text_file" });
    assert(!report.blocked, "not blocked");
    assert(/forbids running commands/.test(report.results[0].error), `error: ${report.results[0].error}`);
  } finally {
    setPermissionContext({ profile: "open", roots: [tmp] });
  }
});

// ----------------------------------------------------------------------- budget

await checkAsync("a hook that overruns its own timeout is killed and does not block", async () => {
  resetHooks();
  // A slow hook must not stall the call: each is capped at its declared
  // timeout, and a kill is not the same as a non-zero exit, so nothing blocks.
  setHookConfig({
    enabled: true,
    matchers: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: sleepCmd, timeoutSec: 1 },
            { type: "command", command: sleepCmd, timeoutSec: 1 },
          ],
        },
      ],
    },
  });

  const started = Date.now();
  const report = await runHooks({ event: "PreToolUse", tool: "write_file" });
  const elapsed = Date.now() - started;
  assert(elapsed < HOOK_BUDGET_MS, `elapsed ${elapsed}ms should stay well under the ${HOOK_BUDGET_MS}ms budget`);
  assert(report.results.length === 2, `both hooks ran: ${report.results.length}`);
  assert(report.results.every((r) => r.timedOut), `results: ${JSON.stringify(report.results)}`);
});

// ------------------------------------------------------------------- tool wrapper

await checkAsync("the wrapper returns the tool result untouched when no hook matches", async () => {
  resetHooks();
  const app = fakeServer();
  applyHookWrapper(app.server);
  app.server.registerTool("read_text_file", { inputSchema: {} }, async () => toolResult("read_text_file", { path: "/x" }));

  const result = await app.call("read_text_file", {});
  assert(result.structuredContent.data.path === "/x", "payload preserved");
  assert(result.structuredContent.data.hooks === undefined, "no hook noise added");
});

await checkAsync("a blocking PreToolUse hook prevents the tool from running", async () => {
  resetHooks();
  setHookConfig({
    enabled: true,
    matchers: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: failCmd }] }] },
  });

  let ran = false;
  const app = fakeServer();
  applyHookWrapper(app.server);
  app.server.registerTool("write_file", { inputSchema: {} }, async () => {
    ran = true;
    return toolResult("write_file", { path: "/x" });
  });

  const result = await app.call("write_file", { path: "/x" });
  assert(ran === false, "the tool must not have run");
  assert(result.structuredContent.ok === false, "reported as an error");
  assert(/Blocked by a PreToolUse hook/.test(result.structuredContent.data.error), `error: ${result.structuredContent.data.error}`);
});

await checkAsync("a failing PostToolUse hook leaves the tool result successful", async () => {
  resetHooks();
  setHookConfig({
    enabled: true,
    matchers: { PostToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: failCmd }] }] },
  });

  const app = fakeServer();
  applyHookWrapper(app.server);
  app.server.registerTool("write_file", { inputSchema: {} }, async () => toolResult("write_file", { path: "/x" }));

  const result = await app.call("write_file", { path: "/x" });
  assert(result.structuredContent.ok === true, "still ok");
  assert(result.structuredContent.data.path === "/x", "payload preserved");
  assert(Array.isArray(result.structuredContent.data.hooks), "hook outcome reported");
  assert(result.structuredContent.data.hooks[0].exitCode === 1, `exit: ${result.structuredContent.data.hooks[0].exitCode}`);
  // The serialized text must agree with the structured payload.
  assert(JSON.parse(result.content[0].text).data.hooks.length === 1, "text re-serialized");
});

// -------------------------------------------------------------- post-edit hooks

await checkAsync("the existing post-edit behaviour still fires, now as a PostToolUse hook", async () => {
  resetHooks();
  const target = path.join(tmp, "sample.ts");
  await fs.writeFile(target, "const x = 1;\n", "utf-8");

  const hooksConfig = path.join(tmp, "post-edit.json");
  await fs.writeFile(
    hooksConfig,
    JSON.stringify({ enabled: true, hooks: [{ glob: "*.ts", command: "echo checked {path}", timeout_ms: 10000 }] }),
    "utf-8"
  );
  process.env.POST_EDIT_HOOKS_CONFIG = hooksConfig;

  try {
    registerPostEditHook();
    const app = fakeServer();
    applyHookWrapper(app.server);
    app.server.registerTool("write_file", { inputSchema: {} }, async () =>
      toolResult("write_file", { path: target, bytes: 13 })
    );

    const result = await app.call("write_file", { path: target });
    const reports = result.structuredContent.data.post_edit_hooks;
    assert(Array.isArray(reports), `post_edit_hooks: ${JSON.stringify(result.structuredContent.data)}`);
    assert(reports[0].file === target, `file: ${reports[0].file}`);
    assert(reports[0].glob === "*.ts", `glob: ${reports[0].glob}`);
    assert(reports[0].stdout.includes("checked"), `stdout: ${reports[0].stdout}`);
  } finally {
    delete process.env.POST_EDIT_HOOKS_CONFIG;
    clearInternalHooks();
  }
});

await checkAsync("post-edit checks are skipped on a dry run", async () => {
  resetHooks();
  const target = path.join(tmp, "sample.ts");
  const hooksConfig = path.join(tmp, "post-edit.json");
  process.env.POST_EDIT_HOOKS_CONFIG = hooksConfig;

  try {
    registerPostEditHook();
    const app = fakeServer();
    applyHookWrapper(app.server);
    app.server.registerTool("edit_file", { inputSchema: {} }, async () =>
      toolResult("edit_file", { path: target, dry_run: true })
    );

    const result = await app.call("edit_file", { path: target });
    assert(result.structuredContent.data.post_edit_hooks === undefined, "nothing ran");
  } finally {
    delete process.env.POST_EDIT_HOOKS_CONFIG;
    clearInternalHooks();
  }
});

await checkAsync("post-edit checks do not fire for a read", async () => {
  resetHooks();
  process.env.POST_EDIT_HOOKS_CONFIG = path.join(tmp, "post-edit.json");
  try {
    registerPostEditHook();
    assert(hasHooks("PostToolUse", "write_file"), "registered for writes");
    assert(!hasHooks("PostToolUse", "read_text_file"), "not registered for reads");
  } finally {
    delete process.env.POST_EDIT_HOOKS_CONFIG;
    clearInternalHooks();
  }
});

resetHooks();
setPermissionContext({ profile: "workspace", roots: [process.cwd()] });
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
