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
import { registerPostEditHook, runPostEditHooks } from "../dist/lib/post-edit-hooks.js";
import { toolResult } from "../dist/lib/tool-result.js";
import { setImportedRuleCheck, setPermissionContext } from "../dist/lib/permissions.js";
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
// A slow hook that reports a numeric non-zero exit code when it is killed,
// rather than the "no exit code at all" a SIGKILLed POSIX child reports. That
// is what Windows does natively — it has no signals, and `taskkill /F` exits 1
// — so on POSIX the shape has to be built with a TERM trap. `wait` is what
// makes the trap fire promptly: a POSIX shell defers a trap until the current
// foreground command returns, so a bare `sleep 5` would swallow the signal.
const trappedSleepCmd = isWindows ? "Start-Sleep -Seconds 5" : 'trap "exit 3" TERM; sleep 5 & wait';
/** Creates `MARKER.txt` in the shell's cwd. Used as an injection payload. */
const markerCmd = isWindows ? "Set-Content MARKER.txt x" : "touch MARKER.txt";
/** The same, under a name an imported deny rule below matches on. */
const deniedCmd = isWindows ? "Set-Content DENIED.txt x" : "touch DENIED.txt";

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

await checkAsync("a hook killed on timeout does not block even when the kill leaves a non-zero exit code", async () => {
  resetHooks();
  // Whether a killed hook reports an exit code is the platform's choice, not a
  // decision the hook made. Windows has no signals: `taskkill /F` exits 1, so a
  // hook that was merely slow arrived here looking exactly like one that
  // deliberately refused, and blocked the tool call. Inferring "was killed"
  // from a null exit code only ever held on POSIX.
  setHookConfig({
    enabled: true,
    matchers: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: trappedSleepCmd, timeoutSec: 1 }] },
      ],
    },
  });

  const report = await runHooks({ event: "PreToolUse", tool: "write_file" });
  const [result] = report.results;
  assert(result.timedOut === true, `the hook should have been killed: ${JSON.stringify(result)}`);
  assert(typeof result.exitCode === "number" && result.exitCode !== 0,
    `this test is only meaningful if the kill leaves a non-zero exit code: ${JSON.stringify(result)}`);
  assert(!report.blocked, `a killed hook decided nothing, so it must not block: ${JSON.stringify(report.blocked)}`);
  assert(!result.blocked, `result should not be marked as a block: ${JSON.stringify(result)}`);
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

await checkAsync("a post-edit check that overruns its timeout is reported and leaves nothing running", async () => {
  resetHooks();
  const target = path.join(tmp, "slow.ts");
  await fs.writeFile(target, "const x = 1;\n", "utf-8");

  const hooksConfig = path.join(tmp, "slow-post-edit.json");
  await fs.writeFile(
    hooksConfig,
    JSON.stringify({ enabled: true, hooks: [{ glob: "*.ts", command: sleepCmd, timeout_ms: 1000 }] }),
    "utf-8"
  );
  process.env.POST_EDIT_HOOKS_CONFIG = hooksConfig;

  try {
    const started = Date.now();
    const out = await runPostEditHooks([target]);
    const elapsed = Date.now() - started;
    const report = out.post_edit_hooks[0];
    assert(report.exit_code === null, `a killed check decided nothing: ${JSON.stringify(report)}`);
    assert(report.stderr === "hook timeout", `stderr: ${JSON.stringify(report.stderr)}`);
    // The kill is awaited before the promise settles, so returning at all means
    // the tree is gone rather than merely signalled. Without that a check that
    // ran to completion in the background would still hold this directory open,
    // which on Windows is what left the fixture unremovable.
    assert(elapsed < 20_000, `should return near its 1s timeout, not run to completion: ${elapsed}ms`);
  } finally {
    delete process.env.POST_EDIT_HOOKS_CONFIG;
    clearInternalHooks();
  }
});

// A hook command is operator-configured, but the path substituted into it is
// not: a model chooses the name of the file it writes. `$(...)` expands inside
// the double quotes the shipped config puts around `{path}` — in a POSIX shell
// and in PowerShell alike — and every character in the payload below is legal
// in a filename on both, so one `write_file` is the whole attack.
await checkAsync("a filename containing shell metacharacters is not executed by a post-edit check", async () => {
  resetHooks();
  const dir = path.join(tmp, "inject");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `inj$(${markerCmd}).ts`);
  await fs.writeFile(target, "const x = 1;\n", "utf-8");

  const hooksConfig = path.join(tmp, "inject-post-edit.json");
  await fs.writeFile(
    hooksConfig,
    // The shipped `profiles/post-edit-hooks.json` shape, verbatim.
    JSON.stringify({
      enabled: true,
      hooks: [{ glob: "*.ts", command: 'node --check "{path}"', timeout_ms: 10000 }],
    }),
    "utf-8"
  );
  process.env.POST_EDIT_HOOKS_CONFIG = hooksConfig;

  try {
    await runPostEditHooks([target]);
    const ran = await fs.access(path.join(dir, "MARKER.txt")).then(() => true, () => false);
    assert(!ran, "the filename was executed as a shell command");
  } finally {
    delete process.env.POST_EDIT_HOOKS_CONFIG;
    clearInternalHooks();
  }
});

// The engine says a hook is not a way around an imported deny rule. That has to
// hold for this path too, or a host that denies a command at the front door
// still runs it whenever a file is written.
await checkAsync("a post-edit check runs the shell CLC_SHELL names", async () => {
  resetHooks();
  const dir = path.join(tmp, "shell-override");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "ok.ts");
  await fs.writeFile(target, "const x = 1;\n", "utf-8");

  const hooksConfig = path.join(tmp, "shell-override-post-edit.json");
  await fs.writeFile(
    hooksConfig,
    JSON.stringify({
      enabled: true,
      hooks: [{ glob: "*.ts", command: 'node --check "{path}"', timeout_ms: 10000 }],
    }),
    "utf-8"
  );
  process.env.POST_EDIT_HOOKS_CONFIG = hooksConfig;

  // A shell that cannot exist: honoured, the check cannot start; ignored, the
  // file is valid TypeScript and the check passes.
  const original = process.env.CLC_SHELL;
  process.env.CLC_SHELL = path.join(dir, "no-such-shell");
  try {
    const out = await runPostEditHooks([target]);
    const report = out.post_edit_hooks[0];
    assert(report.exit_code !== 0, `the check ran under some other shell (exit ${report.exit_code})`);
    assert(/spawn failed/.test(report.stderr ?? ""), `unexpected stderr: ${report.stderr}`);
  } finally {
    if (original === undefined) delete process.env.CLC_SHELL;
    else process.env.CLC_SHELL = original;
    delete process.env.POST_EDIT_HOOKS_CONFIG;
    clearInternalHooks();
  }
});

await checkAsync("an imported deny rule stops a post-edit check", async () => {
  resetHooks();
  const dir = path.join(tmp, "denied");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "sample.ts");
  await fs.writeFile(target, "const x = 1;\n", "utf-8");

  const hooksConfig = path.join(tmp, "denied-post-edit.json");
  await fs.writeFile(
    hooksConfig,
    JSON.stringify({ enabled: true, hooks: [{ glob: "*.ts", command: deniedCmd, timeout_ms: 10000 }] }),
    "utf-8"
  );
  process.env.POST_EDIT_HOOKS_CONFIG = hooksConfig;
  setImportedRuleCheck((tool, argument) =>
    tool === "run_command" && argument.includes("DENIED.txt")
      ? { decision: "deny", rule: "Bash(touch *)" }
      : null
  );

  try {
    const out = await runPostEditHooks([target]);
    const report = out.post_edit_hooks[0];
    assert(/Permission denied/.test(report.error ?? ""), `reported as denied: ${JSON.stringify(report)}`);
    // Refused is not failed: a check that never ran has not judged the file.
    assert(report.exit_code === null, `exit_code: ${report.exit_code}`);
    const ran = await fs.access(path.join(dir, "DENIED.txt")).then(() => true, () => false);
    assert(!ran, "the denied command ran anyway");
  } finally {
    setImportedRuleCheck(null);
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

// A hook that outlives the test that started it keeps its cwd open, and on
// Windows that alone makes rmdir fail with EBUSY — which is how a leaked child
// first showed up here. Worth failing on, so it is asserted rather than
// swallowed by `force`, and asserted as a named check rather than left to throw
// out of the teardown: an uncaught EBUSY after the summary line reports every
// test as passing and the job as failed, attributing the leak to nothing.
// Retried because Windows closes a handle asynchronously, so the directory can
// stay busy for a moment after the process holding it is already gone.
await checkAsync("the fixture directory is released once the hooks have run", async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw new Error(`${tmp} is still held: ${error.code || error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
