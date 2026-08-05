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
import { windowsBatchInvocation } from "../dist/lib/platform.js";
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

// Canonicalised once: on macOS os.tmpdir() sits under /var, a symlink to
// /private/var, and on POSIX a spawned child reports the resolved form from
// process.cwd() (getcwd(3) never consults $PWD), so a lexical fixture root can
// never match what the stub sees.
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clc-delegates-")));
const stubDir = path.join(tmp, "bin");
const work = path.join(tmp, "work");
await fs.mkdir(stubDir, { recursive: true });
await fs.mkdir(work, { recursive: true });

// The stub reports the argv, the stdin and any --prompt-file it was handed, so
// every channel the prompt could travel on is observable.
const stubJs = path.join(stubDir, "stub.mjs");
await fs.writeFile(
  stubJs,
  [
    "import fsp from 'fs/promises';",
    "const mode = process.env.STUB_MODE || 'echo';",
    "const argv = process.argv.slice(2);",
    "if (mode === 'sleep') { setTimeout(() => process.exit(0), 60000); }",
    // No process.exit here: exiting mid-write would truncate the pipe itself,
    // and then the cap under test would never be reached.
    "else if (mode === 'flood') { process.stdout.write('x'.repeat(400 * 1024)); }",
    // The pause lets the parent drain exactly the cap before more arrives, so
    // the boundary case is hit on every platform rather than only where the OS
    // happens to split the stream on a multiple of the cap.
    "else if (mode === 'boundary') { process.stdout.write('x'.repeat(200 * 1024)); setTimeout(() => process.stdout.write('y'.repeat(1024)), 50); }",
    "else if (mode === 'fail') { process.stderr.write('stub refused'); process.exit(3); }",
    "else {",
    // Every delegate spawn closes the child's stdin, including the --version
    // probe and the delegate that reads its prompt from a file, so reading to
    // EOF here always terminates.
    "  let stdin = '';",
    "  process.stdin.setEncoding('utf-8');",
    "  for await (const chunk of process.stdin) stdin += chunk;",
    "  const at = argv.indexOf('--prompt-file');",
    "  const promptFile = at >= 0 ? await fsp.readFile(argv[at + 1], 'utf-8') : null;",
    "  process.stdout.write(JSON.stringify({ name: process.env.STUB_NAME, argv, cwd: process.cwd(), stdin, promptFile }));",
    "  process.exit(0);",
    "}",
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

// Static argv only — the prompt reaches these two on stdin, never as an
// operand, so nothing model-supplied is on the command line cmd.exe re-parses
// when the delegate is a `.cmd` shim on Windows.
const STDIN_ARGV = {
  claude: ["-p", "--output-format", "text"],
  codex: ["exec", "-"],
};

for (const [id, expected] of Object.entries(STDIN_ARGV)) {
  await checkAsync(`${id} is invoked as ${expected.join(" ")} with the prompt on stdin`, async () => {
    resetDelegateProbe();
    const result = await runDelegate({ prompt: "PROMPT", agent: id, timeoutSec: 30 });
    assert(result.ok === true, `failed: ${result.ok === false ? result.error : ""}`);
    assert(result.delegate === id, `delegate: ${result.delegate}`);
    assert(JSON.stringify(result.args) === JSON.stringify(expected), `args: ${JSON.stringify(result.args)}`);

    const seen = JSON.parse(result.output);
    assert(seen.name === id, `stub identity: ${seen.name}`);
    assert(JSON.stringify(seen.argv) === JSON.stringify(expected), `stub argv: ${JSON.stringify(seen.argv)}`);
    assert(seen.stdin === "PROMPT", `stub stdin: ${JSON.stringify(seen.stdin)}`);
  });
}

// grok has no stdin prompt mode, so it gets a file this host writes and deletes
// again; only the generated path travels in argv.
await checkAsync("grok is invoked as --prompt-file with the prompt in the file", async () => {
  resetDelegateProbe();
  const result = await runDelegate({ prompt: "PROMPT", agent: "grok", timeoutSec: 30 });
  assert(result.ok === true, `failed: ${result.ok === false ? result.error : ""}`);
  assert(result.args.length === 2 && result.args[0] === "--prompt-file", `args: ${JSON.stringify(result.args)}`);

  const seen = JSON.parse(result.output);
  assert(seen.name === "grok", `stub identity: ${seen.name}`);
  assert(JSON.stringify(seen.argv) === JSON.stringify(result.args), `stub argv: ${JSON.stringify(seen.argv)}`);
  assert(seen.promptFile === "PROMPT", `prompt file: ${JSON.stringify(seen.promptFile)}`);
  assert(seen.stdin === "", `grok should get no stdin: ${JSON.stringify(seen.stdin)}`);

  let stillThere = true;
  try { await fs.access(result.args[1]); } catch { stillThere = false; }
  assert(!stillThere, `prompt file survived the run: ${result.args[1]}`);
});

// The assertion the whole arrangement exists for. Every character below is a
// separator, an escape or an expansion trigger for at least one of the parsers
// a prompt can cross: sh on POSIX, and on Windows both cmd.exe (`& | < > ^ ( )
// % !` and a bare newline) and the child's own argv parser (`"` and a trailing
// backslash run). The canary is the assertion with teeth — a second command
// created by either shell writes it, and its absence is observed rather than
// inferred from the round-trip.
const CANARY = path.join(work, "pwned.txt");
const NASTY_PROMPT = [
  'fix "the bug"; rm -rf / && echo $HOME',
  `& echo pwned> "${CANARY}" & rem`,
  `; echo pwned > "${CANARY}" ;`,
  "| more ^ 100% %PATH% !PATH! (a) `id` $(id) > out < in C:\\dir\\",
].join("\r\n");

await checkAsync("a hostile prompt reaches every delegate whole and spawns nothing", async () => {
  await fs.rm(CANARY, { force: true });

  for (const agent of ["claude", "codex", "grok", "opencode"]) {
    resetDelegateProbe();
    const result = await runDelegate({ prompt: NASTY_PROMPT, agent, timeoutSec: 30 });

    // opencode takes the prompt as an operand — it offers no stdin or file
    // mode — so for it the prompt is expected in argv, and on Windows the
    // encoder refuses a multi-line one outright because cmd.exe ends a command
    // at a line break whatever the quoting. Refusing is the point: truncating
    // into a command line whose tail runs unquoted would be the injection.
    // The other three keep argv free of prompt text on every OS.
    const viaArgv = agent === "opencode";

    if (viaArgv && process.platform === "win32") {
      assert(result.ok === false, "a multi-line argv prompt must be refused, not silently emptied");
      assert(/newline/.test(result.error), `diagnostic should name the cause: ${result.error}`);
      continue;
    }

    assert(result.ok === true, `${agent} failed: ${result.ok === false ? result.error : ""}`);

    if (!viaArgv) {
      for (const arg of result.args) {
        assert(!arg.includes("rm -rf"), `${agent} put prompt text in argv: ${arg}`);
        assert(!arg.includes("echo pwned"), `${agent} put prompt text in argv: ${arg}`);
        // What is left is a registry literal or a path this host generated, and
        // a cmd.exe command line can carry no newline in any of them.
        assert(!/[\r\n]/.test(arg), `${agent} argv element is unrepresentable: ${JSON.stringify(arg)}`);
      }
      // The same argv, quoted for a Windows batch delegate: this must not throw,
      // and it is the encoding the Windows CI then runs for real.
      windowsBatchInvocation("C:\\npm\\claude.cmd", result.args, { SystemRoot: "C:\\Windows" });
    }

    // A stub that never started is not a pass: injected text would leave the
    // JSON unparseable, but a swallowed prompt would not.
    const seen = JSON.parse(result.output);
    assert(seen.name === agent, `${agent} stub identity: ${seen.name}`);
    const delivered =
      agent === "grok" ? seen.promptFile : viaArgv ? seen.argv[seen.argv.length - 1] : seen.stdin;
    assert(delivered === NASTY_PROMPT, `${agent} prompt round-trip differs: ${JSON.stringify(delivered)}`);
  }

  let hatched = true;
  try { await fs.access(CANARY); } catch { hatched = false; }
  assert(!hatched, "the prompt executed a second command");
});

// The refusal above must not be the encoder simply rejecting anything hostile:
// a single-line prompt is the case the argv channel has to carry. The encoding
// itself is asserted against models of both parsers in test-platform.mjs; what
// is checked here is the delegate path end to end.
await checkAsync("a single-line hostile prompt still reaches an argv-channel delegate", async () => {
  await fs.rm(CANARY, { force: true });
  const single = `fix "the bug" & echo pwned > "${CANARY}" & rem 100% %PATH% !PATH! ^ | > < C:\\dir\\`;

  resetDelegateProbe();
  const result = await runDelegate({ prompt: single, agent: "opencode", timeoutSec: 30 });
  assert(result.ok === true, `failed: ${result.ok === false ? result.error : ""}`);
  assert(result.args[result.args.length - 1] === single, `argv: ${JSON.stringify(result.args)}`);

  // Accepted rather than refused, and this is the encoding Windows CI then runs.
  windowsBatchInvocation("C:\\npm\\opencode.cmd", result.args, { SystemRoot: "C:\\Windows" });

  const seen = JSON.parse(result.output);
  assert(seen.argv[seen.argv.length - 1] === single, `stub argv: ${JSON.stringify(seen.argv)}`);

  let hatched = true;
  try { await fs.access(CANARY); } catch { hatched = false; }
  assert(!hatched, "the prompt executed a second command");
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

await checkAsync("truncation is still flagged when the capture lands exactly on the cap", async () => {
  resetDelegateProbe();
  process.env.STUB_MODE = "boundary";
  try {
    const result = await runDelegate({ prompt: "hi", agent: "codex", timeoutSec: 30 });
    assert(result.ok === true, "ran");
    assert(result.truncated === true, "truncation flagged at the boundary");
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
