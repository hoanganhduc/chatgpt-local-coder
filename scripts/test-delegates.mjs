/**
 * Delegate CLIs (T8): argv construction, timeout enforcement, output
 * truncation, and the no-delegate error shape.
 *
 * A stub executable on a temporary PATH stands in for the real agent CLIs, so
 * the assertions never depend on which of them the developer has installed and
 * nothing here ever spends a token.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  detectDelegates,
  orderDelegates,
  probeDelegates,
  resetDelegateProbe,
  runDelegate,
  MAX_DELEGATE_OUTPUT_BYTES,
} from "../dist/delegates/index.js";
import { setPermissionContext } from "../dist/lib/permissions.js";
import { setDefaultCwd } from "../dist/lib/path-security.js";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
function check(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-delegates-"));
const stubDir = path.join(tmp, "bin");
const work = path.join(tmp, "work");
await fs.mkdir(stubDir, { recursive: true });
await fs.mkdir(work, { recursive: true });

// The stub reports the argv it was handed, so argv construction is observable.
const stubJs = path.join(stubDir, "stub.mjs");
await fs.writeFile(
  stubJs,
  [
    "const mode = process.env.STUB_MODE || 'echo';",
    "const argv = process.argv.slice(2);",
    "if (mode === 'sleep') { setTimeout(() => process.exit(0), 60000); }",
    // No process.exit here: exiting mid-write would truncate the pipe itself,
    // and then the cap under test would never be reached.
    "else if (mode === 'flood') { process.stdout.write('x'.repeat(400 * 1024)); }",
    "else if (mode === 'fail') { process.stderr.write('stub refused'); process.exit(3); }",
    "else { process.stdout.write(JSON.stringify({ name: process.env.STUB_NAME, argv, cwd: process.cwd() })); process.exit(0); }",
  ].join("\n"),
  "utf-8"
);

/** Put a fake CLI named `name` on the temporary PATH. */
async function installStub(name) {
  const isWindows = process.platform === "win32";
  const file = path.join(stubDir, isWindows ? `${name}.cmd` : name);
  const body = isWindows
    ? `@echo off\r\nset STUB_NAME=${name}\r\n"${process.execPath}" "${stubJs}" %*\r\n`
    : `#!/bin/sh\nSTUB_NAME=${name} exec "${process.execPath}" "${stubJs}" "$@"\n`;
  await fs.writeFile(file, body, "utf-8");
  if (!isWindows) await fs.chmod(file, 0o755);
  return file;
}

const originalPath = process.env.PATH;
// An empty PATH plus only the stub dir means a real `claude` on the developer's
// machine cannot be picked up by accident.
process.env.PATH = stubDir;

setPermissionContext({ profile: "open", roots: [tmp] });
setDefaultCwd(work);

// ------------------------------------------------------------------- ordering

check("delegates.order is honoured and unknown names are dropped", () => {
  assert(orderDelegates(["grok", "claude"]).join(",") === "grok,claude,codex,opencode", orderDelegates(["grok", "claude"]).join(","));
  assert(orderDelegates(["nope"]).join(",") === "claude,codex,grok,opencode", "unknown name ignored");
  assert(orderDelegates(undefined).join(",") === "claude,codex,grok,opencode", "default order");
});

check("detection reports every known CLI, available or not", () => {
  const found = detectDelegates();
  assert(found.length === 4, `entries: ${found.length}`);
  assert(found.every((d) => d.available === false), "nothing installed yet");
});

// ---------------------------------------------------------------- no delegate

await checkAsync("with no CLI installed the failure names every probed binary", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "hi" });
  assert(result.ok === false, "expected a failure result");
  assert(!("exitCode" in result), "no run happened");
  for (const binary of ["claude", "codex", "grok", "opencode"]) {
    assert(result.error.includes(binary), `error should name ${binary}: ${result.error}`);
  }
  assert(result.probed.length === 4, `probed: ${result.probed.length}`);
});

await checkAsync("asking for a delegate that is not installed says so by name", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "hi", agent: "codex" });
  assert(result.ok === false, "expected a failure result");
  assert(/Delegate "codex" is not installed/.test(result.error), `error: ${result.error}`);
});

await checkAsync("an unknown delegate name is rejected before anything is spawned", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "hi", agent: "gemini" });
  assert(result.ok === false, "expected a failure result");
  assert(/Unknown delegate "gemini"/.test(result.error), `error: ${result.error}`);
});

// ------------------------------------------------------------------ argv shape

await installStub("claude");
await installStub("codex");
await installStub("grok");
await installStub("opencode");

const ARGV = {
  claude: ["-p", "PROMPT", "--output-format", "text"],
  codex: ["exec", "PROMPT"],
  grok: ["-p", "PROMPT"],
  opencode: ["run", "PROMPT"],
};

for (const [id, expected] of Object.entries(ARGV)) {
  await checkAsync(`${id} is invoked as ${expected.join(" ")}`, async () => {
    resetDelegateProbe();
    const result = await runDelegate({ prompt: "PROMPT", agent: id, timeoutSec: 30 });
    assert(result.ok === true, `failed: ${result.ok === false ? result.error : ""}`);
    assert(result.delegate === id, `delegate: ${result.delegate}`);
    assert(JSON.stringify(result.args) === JSON.stringify(expected), `args: ${JSON.stringify(result.args)}`);

    const seen = JSON.parse(result.output);
    assert(seen.name === id, `stub identity: ${seen.name}`);
    assert(JSON.stringify(seen.argv) === JSON.stringify(expected), `stub argv: ${JSON.stringify(seen.argv)}`);
  });
}

await checkAsync("a prompt with shell metacharacters is passed through as one argument", async () => {
  resetDelegateProbe();
  const nasty = 'fix "the bug"; rm -rf / && echo $HOME';
  const result = await runDelegate({ prompt: nasty, agent: "codex", timeoutSec: 30 });
  assert(result.ok === true, "ran");
  const seen = JSON.parse(result.output);
  assert(seen.argv.length === 2, `argv length: ${seen.argv.length}`);
  assert(seen.argv[1] === nasty, `prompt round-trip: ${seen.argv[1]}`);
});

await checkAsync("the first available CLI in order wins when none is named", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "hi", order: ["grok", "claude"], timeoutSec: 30 });
  assert(result.ok === true, "ran");
  assert(result.delegate === "grok", `delegate: ${result.delegate}`);
});

await checkAsync("the version probe records what each CLI prints", async () => {
  resetDelegateProbe();
  const entries = await probeDelegates(undefined, { refresh: true });
  assert(entries.every((e) => e.available), "all four stubs found");
  // `--version` reaches the stub as ordinary argv, so it echoes it back.
  assert(entries.every((e) => typeof e.version === "string" && e.version.length), "version captured");
});

// --------------------------------------------------------------------- cwd

await checkAsync("cwd is resolved through the permission profile", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "hi", agent: "codex", cwd: work, timeoutSec: 30 });
  assert(result.ok === true, "ran");
  const seen = JSON.parse(result.output);
  assert(path.resolve(seen.cwd) === path.resolve(work), `cwd: ${seen.cwd}`);
});

await checkAsync("a cwd outside the workspace roots is refused under the workspace profile", async () => {
  resetDelegateProbe();
  setPermissionContext({ profile: "workspace", roots: [work] });
  try {
    await runDelegate({ prompt: "hi", agent: "codex", cwd: os.tmpdir(), timeoutSec: 30 });
    throw new Error("expected a throw");
  } catch (error) {
    assert(/outside workspace roots/.test(error.message), `message: ${error.message}`);
  } finally {
    setPermissionContext({ profile: "open", roots: [tmp] });
  }
});

await checkAsync("the readonly profile refuses to delegate at all", async () => {
  resetDelegateProbe();
  setPermissionContext({ profile: "readonly", roots: [work] });
  try {
    await runDelegate({ prompt: "hi", agent: "codex", timeoutSec: 30 });
    throw new Error("expected a throw");
  } catch (error) {
    assert(/forbids running commands/.test(error.message), `message: ${error.message}`);
  } finally {
    setPermissionContext({ profile: "open", roots: [tmp] });
  }
});

// ------------------------------------------------------------------ disabled

await checkAsync("delegates.enabled = false refuses without probing a run", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "hi", enabled: false });
  assert(result.ok === false, "expected a failure result");
  assert(/Delegation is disabled/.test(result.error), `error: ${result.error}`);
});

// ------------------------------------------------------------- output limits

await checkAsync("output beyond the cap is truncated and flagged", async () => {
  resetDelegateProbe();
  process.env.STUB_MODE = "flood";
  try {
    const result = await runDelegate({ prompt: "hi", agent: "codex", timeoutSec: 30 });
    assert(result.ok === true, "ran");
    assert(result.truncated === true, "truncation flagged");
    assert(
      Buffer.byteLength(result.output) <= MAX_DELEGATE_OUTPUT_BYTES,
      `output bytes: ${Buffer.byteLength(result.output)}`
    );
  } finally {
    delete process.env.STUB_MODE;
  }
});

await checkAsync("a non-zero exit is reported rather than thrown", async () => {
  resetDelegateProbe();
  process.env.STUB_MODE = "fail";
  try {
    const result = await runDelegate({ prompt: "hi", agent: "codex", timeoutSec: 30 });
    assert(result.ok === true, "the run itself succeeded");
    assert(result.exitCode === 3, `exit: ${result.exitCode}`);
    assert(result.stderr.includes("stub refused"), `stderr: ${result.stderr}`);
  } finally {
    delete process.env.STUB_MODE;
  }
});

await checkAsync("a delegate that overruns its timeout is killed and flagged", async () => {
  resetDelegateProbe();
  process.env.STUB_MODE = "sleep";
  const started = Date.now();
  try {
    const result = await runDelegate({ prompt: "hi", agent: "codex", timeoutSec: 1 });
    assert(result.ok === true, "ran");
    assert(result.timedOut === true, "timeout flagged");
    assert(Date.now() - started < 20_000, `elapsed: ${Date.now() - started}ms`);
  } finally {
    delete process.env.STUB_MODE;
  }
});

process.env.PATH = originalPath;
setPermissionContext({ profile: "workspace", roots: [process.cwd()] });
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
