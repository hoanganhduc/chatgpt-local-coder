/**
 * Verify the platform adapter reports this host correctly and produces a
 * runnable shell spec on every supported OS.
 */
import { spawn } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  platformId,
  isWindows,
  archId,
  exeSuffix,
  pathsAreCaseInsensitive,
  which,
  defaultShell,
  detachedSpawnOptions,
  runExecutable,
  windowsBatchInvocation,
  homeDir,
} from "../dist/lib/platform.js";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  const id = platformId();
  if (!["win32", "darwin", "linux"].includes(id)) throw new Error(`unexpected platform ${id}`);
  if (id !== process.platform) throw new Error(`platformId ${id} != process.platform ${process.platform}`);
  ok(`platformId = ${id}`);
} catch (e) { fail("platformId", e.message); }

try {
  if (isWindows() !== (process.platform === "win32")) throw new Error("isWindows disagrees with process.platform");
  ok(`isWindows = ${isWindows()}`);
} catch (e) { fail("isWindows", e.message); }

try {
  const arch = archId();
  if (!["amd64", "arm64"].includes(arch)) throw new Error(`unexpected arch ${arch}`);
  ok(`archId = ${arch}`);
} catch (e) { fail("archId", e.message); }

try {
  const suffix = exeSuffix();
  const expected = process.platform === "win32" ? ".exe" : "";
  if (suffix !== expected) throw new Error(`exeSuffix "${suffix}" != "${expected}"`);
  ok(`exeSuffix = "${suffix}"`);
} catch (e) { fail("exeSuffix", e.message); }

try {
  // Case sensitivity is a real filesystem property, not a preference: only
  // Linux is treated as case-sensitive.
  const expected = process.platform !== "linux";
  if (pathsAreCaseInsensitive() !== expected) throw new Error("case sensitivity mismatch");
  ok(`pathsAreCaseInsensitive = ${pathsAreCaseInsensitive()}`);
} catch (e) { fail("pathsAreCaseInsensitive", e.message); }

try {
  if (homeDir() !== os.homedir()) throw new Error("homeDir mismatch");
  ok(`homeDir = ${homeDir()}`);
} catch (e) { fail("homeDir", e.message); }

try {
  const node = which(process.platform === "win32" ? "node.exe" : "node");
  if (!node) throw new Error("node not found on PATH");
  ok(`which(node) = ${node}`);
  if (which("definitely-not-a-real-binary-xyz")) throw new Error("which returned a path for a missing binary");
  ok("which returns undefined for a missing binary");
} catch (e) { fail("which", e.message); }

try {
  const shell = defaultShell();
  if (!shell.command) throw new Error("shell.command empty");
  const args = shell.args("echo hi");
  if (!Array.isArray(args) || !args.length) throw new Error("shell.args produced no argv");
  if (!args.includes("echo hi")) throw new Error("shell.args dropped the script");
  ok(`defaultShell = ${shell.label} (${shell.command} ${args.slice(0, -1).join(" ")})`);
} catch (e) { fail("defaultShell", e.message); }

try {
  const opts = detachedSpawnOptions();
  if (typeof opts.detached !== "boolean" || typeof opts.windowsHide !== "boolean") {
    throw new Error("detachedSpawnOptions shape wrong");
  }
  ok(`detachedSpawnOptions = ${JSON.stringify(opts)}`);
} catch (e) { fail("detachedSpawnOptions", e.message); }

try {
  const result = await runExecutable(process.execPath, ["-e", "process.stdout.write('pong')"], { timeoutMs: 20000 });
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
  if (result.stdout.trim() !== "pong") throw new Error(`unexpected stdout ${JSON.stringify(result.stdout)}`);
  ok("runExecutable captures stdout and exit code");
} catch (e) { fail("runExecutable", e.message); }

try {
  const result = await runExecutable("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5000 });
  if (result.exitCode === 0) throw new Error("missing binary reported success");
  if (!result.stderr) throw new Error("missing binary produced no diagnostic");
  // A child that never started and a child that ran silently both come back as
  // `exitCode: null` with an empty stdout, and a caller that cannot tell them
  // apart reports a delegation that never happened as a success — which is
  // exactly how the Windows batch defect stayed invisible.
  if (result.spawnFailed !== true) throw new Error("a failed spawn is not flagged as one");
  ok("runExecutable flags a spawn that never started");
} catch (e) { fail("runExecutable missing binary", e.message); }

try {
  // Ten megabytes against a thousand-byte cap. Nothing here reads the output;
  // the point is that a command cannot make this host hold all of it, since
  // past V8's maximum string length the append throws inside a stream listener
  // where nothing catches it and the process leaves.
  const result = await runExecutable(
    process.execPath,
    ["-e", "const chunk = 'x'.repeat(1024 * 64); for (let i = 0; i < 160; i++) process.stdout.write(chunk);"],
    { timeoutMs: 30000, maxOutputBytes: 1000 }
  );
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
  // One chunk of overshoot is expected: a chunk that arrives under the cap is
  // taken whole rather than cut, so a multi-byte character cannot be halved.
  if (result.stdout.length > 200_000) {
    throw new Error(`kept ${result.stdout.length} chars against a 1000-byte cap`);
  }
  if (result.truncated !== true) throw new Error("output was dropped without saying so");
  if (!/truncated/.test(result.stdout)) throw new Error("nothing in the output says it is incomplete");
  ok("runExecutable bounds what it captures and reports what it dropped");
} catch (e) { fail("runExecutable output cap", e.message); }

try {
  const shell = defaultShell();
  const result = await runExecutable(shell.command, shell.args("exit 7"), { timeoutMs: 30000 });
  if (result.exitCode !== 7) throw new Error(`exit ${result.exitCode}`);
  if (result.spawnFailed) throw new Error("a process that ran was flagged as a failed spawn");
  ok("a process that ran and exited non-zero is not confused with a failed spawn");
} catch (e) { fail("runExecutable spawn flag", e.message); }

try {
  const shell = defaultShell();
  const result = await runExecutable(shell.command, shell.args("echo platform-shell-ok"), { timeoutMs: 30000 });
  if (result.exitCode !== 0) throw new Error(`shell exit ${result.exitCode}: ${result.stderr}`);
  if (!result.stdout.includes("platform-shell-ok")) throw new Error(`shell stdout ${JSON.stringify(result.stdout)}`);
  ok("defaultShell actually executes a command on this host");
} catch (e) { fail("defaultShell execution", e.message); }

try {
  // A timeout has to kill the child even when the host's PATH cannot resolve a
  // helper. Windows has no process group to signal, so the tree is walked by
  // taskkill; spawned by bare name that lookup went through PATH, and libuv
  // does not fall back to System32 the way CreateProcess does. With PATH
  // narrowed the kill failed with ENOENT, the failure was swallowed, and the
  // child ran to completion with `timedOut` reported as true — a runaway
  // delegate that nothing stopped. POSIX never saw it: process.kill is a
  // syscall and consults no PATH.
  const stripped = { ...process.env };
  for (const key of Object.keys(stripped)) if (key.toLowerCase() === "path") delete stripped[key];

  const started = Date.now();
  const result = await runExecutable(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    env: stripped,
    timeoutMs: 1000,
  });
  const elapsed = Date.now() - started;
  if (result.timedOut !== true) throw new Error("timeout not flagged");
  if (result.spawnFailed) throw new Error("the child never started, so nothing was killed");
  if (elapsed > 20000) throw new Error(`child outlived its timeout: ${elapsed}ms`);
  ok("a child that overruns its timeout is killed even when PATH is empty");
} catch (e) { fail("timeout kill without PATH", e.message); }

// ------------------------------------- when a run settles, and what it killed
//
// A timeout is only a bound if it reaches everything the command started, and a
// run is only bounded at all if it can settle. Waiting for `close` waits for the
// stdio pipes as well as the process, so anything the command leaves running
// holds the inherited stdout open and keeps the promise pending for as long as
// it lives. The fixtures below are written in Node rather than shell so the same
// tree exists on every supported OS.

const treeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clc-tree-"));
const spawner = path.join(treeDir, "spawner.mjs");
await fsp.writeFile(
  spawner,
  [
    'import { spawn } from "child_process";',
    'import fs from "fs";',
    "const [, self, pidFile, mode] = process.argv;",
    "",
    "// `inherit` hands the next process the very pipe this one was given, so the",
    "// pipe outlives whoever started it.",
    "const spawnSelf = (next, opts) =>",
    '  spawn(process.execPath, [self, pidFile, next], { stdio: "inherit", ...opts });',
    "",
    "// The long-lived process every case below is really about.",
    'if (mode === "leaf") { fs.writeFileSync(pidFile, String(process.pid)); setTimeout(() => {}, 25000); }',
    "",
    "// Stays alive itself, so the run times out with the leaf still under it.",
    'else if (mode === "hold") { spawnSelf("leaf"); setTimeout(() => {}, 25000); }',
    "",
    "// Also stays alive, but the leaf is started one level down by a process that",
    "// leaves at once — so the leaf reparents to init long before the timeout. A",
    "// tree walked from this pid would no longer find it; the process group it",
    "// stays in still reaches it.",
    'else if (mode === "reparent") { spawnSelf("daemon"); setTimeout(() => {}, 25000); }',
    "",
    "// Daemonises: leaves the leaf running and exits 0 straight away, the shape a",
    "// launcher takes. Nothing has timed out, so nothing should be killed.",
    'else if (mode === "daemon") { spawnSelf("leaf").unref(); process.exit(0); }',
    "",
    "// `detached` is setsid: the leaf leads a process group of its own, so the",
    "// group kill cannot reach it and it holds the pipe open through the timeout.",
    'else if (mode === "escape") { spawnSelf("leaf", { detached: true }).unref(); setTimeout(() => {}, 25000); }',
  ].join("\n"),
  "utf-8"
);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function runTreeCase(mode, { timeoutMs = 1000, settleBy = 10000, hangAfter = 20000 } = {}) {
  const pidFile = path.join(treeDir, `${mode}.pid`);
  const started = Date.now();
  const pending = runExecutable(process.execPath, [spawner, pidFile, mode], { timeoutMs });
  const outcome = await Promise.race([
    pending.then((result) => ({ result })),
    new Promise((resolve) => setTimeout(() => resolve(null), hangAfter)),
  ]);
  const elapsed = Date.now() - started;
  const leaf = Number(await fsp.readFile(pidFile, "utf-8").catch(() => "0"));
  // Whatever the verdict, do not leave a 25s process behind for the next test.
  const cleanup = () => { if (leaf) { try { process.kill(leaf, "SIGKILL"); } catch { /* gone */ } } };

  if (!outcome) {
    cleanup();
    throw new Error(`never settled: a descendant held the stdout pipe for the full ${elapsed}ms`);
  }
  if (!leaf) { cleanup(); throw new Error("fixture never recorded a leaf pid"); }
  if (elapsed > settleBy) { cleanup(); throw new Error(`settled ${elapsed}ms after a ${timeoutMs}ms timeout`); }
  return { result: outcome.result, elapsed, leaf, cleanup };
}

/** The kill is signalled, not awaited by `runExecutable`, so allow it a moment. */
async function reaped(leaf) {
  for (let attempt = 0; attempt < 20 && isAlive(leaf); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(leaf);
}

try {
  const { result, leaf, cleanup } = await runTreeCase("hold");
  const gone = await reaped(leaf);
  cleanup();
  if (result.timedOut !== true) throw new Error("timeout not flagged");
  if (!gone) throw new Error(`leaf ${leaf} outlived the timeout that killed its parent`);
  ok("a timed-out command is killed along with the descendants it started");
} catch (e) { fail("timeout kills the tree", e.message); }

try {
  const { leaf, cleanup } = await runTreeCase("reparent");
  const gone = await reaped(leaf);
  cleanup();
  if (!gone) throw new Error(`reparented leaf ${leaf} outlived the timeout`);
  ok("a descendant already reparented to init is still reached by the timeout");
} catch (e) { fail("timeout kills a reparented descendant", e.message); }

try {
  // Ten seconds of timeout against a command that exits in one: the run has to
  // settle because the process is gone, not because a limit was hit.
  const { result, elapsed, leaf, cleanup } = await runTreeCase("daemon", {
    timeoutMs: 10000,
    settleBy: 8000,
  });
  const survived = isAlive(leaf);
  cleanup();
  if (result.timedOut === true) throw new Error(`a command that exited in ${elapsed}ms was reported as timed out`);
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}, expected the launcher's own 0`);
  if (!survived) throw new Error(`the daemon this launcher deliberately left behind was killed anyway`);
  ok("a launcher that daemonises and exits settles at once, and its daemon is left alone");
} catch (e) { fail("daemonising launcher", e.message); }

try {
  const { result, leaf, cleanup } = await runTreeCase("escape");
  cleanup();
  if (result.timedOut !== true) throw new Error("timeout not flagged");
  if (!leaf) throw new Error("fixture never recorded a leaf pid");
  ok("a descendant that leaves the process group cannot keep a timed-out run pending");
} catch (e) { fail("descendant outside the group", e.message); }

await fsp.rm(treeDir, { recursive: true, force: true });

// Detaching a child is what gives it a process group to kill, and it is also
// what takes it out of the terminal's foreground group — so Ctrl+C stops
// reaching it. The signal has to be forwarded by hand, and this is the check
// that says so: without the forwarding, interrupting the CLI leaves whatever it
// was running alive. Windows is exempt because nothing is detached there, so
// there is no group for a console Ctrl+C to miss.
if (!isWindows()) {
  const signalDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clc-signal-"));
  try {
    const pidFile = path.join(signalDir, "child.pid");
    const hostFile = path.join(signalDir, "host.mjs");
    await fsp.writeFile(
      hostFile,
      [
        `import { runExecutable } from ${JSON.stringify(new URL("../dist/lib/platform.js", import.meta.url).href)};`,
        "const [, , pidFile] = process.argv;",
        "await runExecutable(",
        "  process.execPath,",
        '  ["-e", \'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 25000);\', pidFile],',
        "  { timeoutMs: 25000 }",
        ");",
      ].join("\n"),
      "utf-8"
    );

    // The host leads its own group so the interrupt can be delivered the way a
    // terminal delivers Ctrl+C — to the whole foreground group, not to one pid.
    // Signalling the host alone would prove nothing: it never reached the child
    // that way, before this change or after it.
    const host = spawn(process.execPath, [hostFile, pidFile], { stdio: "ignore", detached: true });
    let child = 0;
    for (let attempt = 0; attempt < 100 && !child; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      child = Number(await fsp.readFile(pidFile, "utf-8").catch(() => "0"));
    }
    if (!child) throw new Error("the host never started a child to interrupt");

    process.kill(-host.pid, "SIGINT");
    for (let attempt = 0; attempt < 30 && isAlive(child); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const survived = isAlive(child);
    if (survived) try { process.kill(child, "SIGKILL"); } catch { /* gone */ }
    if (survived) throw new Error(`child ${child} survived the interrupt that stopped its host`);
    ok("interrupting the host kills the children it spawned");
  } catch (e) {
    fail("SIGINT reaches spawned children", e.message);
  } finally {
    await fsp.rm(signalDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------- Windows batch command line
//
// Windows cannot start a `.cmd`/`.bat` itself, and an npm-installed CLI is one,
// so `runExecutable` builds a cmd.exe command line by hand. Only Windows can
// run it, but the encoding is a pure string function and the rules it has to
// satisfy are the same everywhere, so it is asserted on every OS — a developer
// on Linux or macOS otherwise has no way to see a broken escape at all.

/** cmd.exe's view: `/s` strips the outer quotes, then `"` toggles quoting. */
function outsideQuotedRegions(line) {
  let quoted = false;
  let loose = "";
  for (const char of line) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted) loose += char;
  }
  return { loose, balanced: !quoted };
}

/** The child's view: CommandLineToArgvW / C runtime argv splitting. */
function parseChildArgv(line) {
  const argv = [];
  let current = "";
  let quoted = false;
  let started = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (!quoted && (char === " " || char === "\t")) {
      if (started) { argv.push(current); current = ""; started = false; }
      i += 1;
      continue;
    }
    started = true;
    if (char === "\\") {
      let run = 0;
      while (line[i] === "\\") { run += 1; i += 1; }
      if (line[i] === '"') {
        current += "\\".repeat(Math.floor(run / 2));
        if (run % 2) { current += '"'; i += 1; }
        continue;
      }
      current += "\\".repeat(run);
      continue;
    }
    if (char === '"') {
      // `""` inside a quoted argument is one literal quote.
      if (quoted && line[i + 1] === '"') { current += '"'; i += 2; continue; }
      quoted = !quoted;
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  if (started) argv.push(current);
  return argv;
}

/** cmd.exe expands `%…%` before it looks at quoting; the escape leaves one `%`. */
function expandPercent(line) {
  return line.split("%%cd:~,%").join("%");
}

const WIN_ENV = { SystemRoot: "C:\\Windows" };

try {
  const batch = (command, args) => windowsBatchInvocation(command, args, WIN_ENV);
  if (batch("C:\\bin\\node.exe", ["-e", "1"]) !== null) throw new Error("an executable was treated as a batch file");
  if (batch("/usr/bin/claude", []) !== null) throw new Error("an extensionless name was treated as a batch file");
  if (batch("C:\\bin\\claude.cmdx", []) !== null) throw new Error("a .cmdx name was treated as a batch file");
  for (const name of ["C:\\bin\\claude.cmd", "C:\\bin\\claude.BAT", "C:\\bin\\claude.cmd. .", "C:\\bin\\claude.cmd::$DATA"]) {
    // Windows drops trailing dots and spaces and ignores a stream suffix, so
    // all of these open the same batch file (CVE-2024-43402 was that bypass).
    if (batch(name, []) === null) throw new Error(`missed a batch target: ${name}`);
  }
  ok("windowsBatchInvocation detects exactly the batch targets Windows would");
} catch (e) { fail("windowsBatchInvocation detection", e.message); }

try {
  const built = windowsBatchInvocation("C:\\Program Files\\npm\\claude.cmd", ["-p"], {
    ComSpec: "C:\\evil\\payload.exe",
    SystemRoot: "C:\\Windows",
  });
  if (built.command !== "C:\\Windows\\System32\\cmd.exe") throw new Error(`ComSpec honoured: ${built.command}`);
  if (built.argv0 !== `"${built.command}"`) throw new Error(`argv0 unquoted: ${built.argv0}`);
  const switches = built.args.slice(0, 5).join(" ");
  if (switches !== "/d /e:on /v:off /s /c") throw new Error(`switches: ${switches}`);
  const kept = windowsBatchInvocation("x.cmd", [], { ComSpec: "C:\\Windows\\SysWOW64\\CMD.EXE" });
  if (kept.command !== "C:\\Windows\\SysWOW64\\CMD.EXE") throw new Error(`a real cmd.exe was replaced: ${kept.command}`);
  ok("windowsBatchInvocation only ever runs a real cmd.exe");
} catch (e) { fail("windowsBatchInvocation ComSpec", e.message); }

try {
  // The payload shapes that made CVE-2024-24576 exploitable, plus one of every
  // character either parser treats specially.
  const hostile = [
    "exec",
    'a" & calc.exe & "b',
    "%PATH%",
    "!PATH!",
    "100% done",
    "^ & | < > ( ) ; ,",
    "C:\\dir\\",
    'trailing\\"quote',
    "",
    'she said ""hi""',
  ];
  const command = "C:\\Program Files\\npm\\claude.cmd";
  const built = windowsBatchInvocation(command, hostile, WIN_ENV);
  const wrapped = built.args[5];
  if (!wrapped.startsWith('"') || !wrapped.endsWith('"')) throw new Error("the command line is not wrapped");

  const line = wrapped.slice(1, -1);
  const { loose, balanced } = outsideQuotedRegions(line);
  if (!balanced) throw new Error("quoting is left open at the end of the line");
  // Anything cmd.exe sees outside a quoted region is syntax. The only thing
  // outside one here is the single space between argv elements.
  if (/[^ ]/.test(loose)) throw new Error(`cmd.exe metacharacters escaped quoting: ${JSON.stringify(loose)}`);
  // Every `%` is part of the zero-length-substring escape, so cmd.exe's
  // expansion phase — which runs before quoting is considered — has nothing to
  // expand and nothing it produces is re-scanned as syntax.
  if (line.split("%%cd:~,%").join("").includes("%")) throw new Error("a bare % survived quoting");

  // Both cmd.exe passes preserve quotes, so the shim's `%*` hands the child the
  // same text, and the child's own parser has to give back what went in.
  const seen = parseChildArgv(expandPercent(line));
  const want = [command, ...hostile];
  if (JSON.stringify(seen) !== JSON.stringify(want)) {
    throw new Error(`argv round-trip: ${JSON.stringify(seen)}`);
  }
  ok("windowsBatchInvocation quotes argv for cmd.exe and for the child at once");
} catch (e) { fail("windowsBatchInvocation quoting", e.message); }

try {
  // The harness is only worth its assertions if it fails the encodings that are
  // known to be exploitable: no quoting at all, and CRT-style `\"` escaping,
  // which cmd.exe does not understand and which reopens the quoted region.
  const program = "C:\\npm\\claude.cmd";
  for (const [label, payload, encode] of [
    // What `shell: true` would produce: nothing is quoted at all.
    ["unquoted", "a & calc.exe & b", (v) => v],
    // Quotes without an escape for the quote itself.
    ["quoted only", 'a" & calc.exe & "b', (v) => `"${v}"`],
    // The child's parser is satisfied, but cmd.exe has no backslash escape, so
    // its quoted region reopens — the shape that made CVE-2024-24576 work.
    ["CRT-style backslash escape", 'a" & calc.exe & "b', (v) => `"${v.split('"').join('\\"')}"`],
  ]) {
    const line = [`"${program}"`, '"exec"', encode(payload)].join(" ");
    const leaked = /[&|<>]/.test(outsideQuotedRegions(line).loose);
    const seen = parseChildArgv(expandPercent(line));
    const mangled = JSON.stringify(seen) !== JSON.stringify([program, "exec", payload]);
    if (!leaked && !mangled) throw new Error(`${label} was not detected as an escape`);
  }
  ok("the quoting harness still fails the encodings known to be exploitable");
} catch (e) { fail("windowsBatchInvocation negative control", e.message); }

try {
  // A newline ends a cmd.exe command wherever it appears, quoted or not, so it
  // is refused rather than half-passed. Nothing model-supplied reaches argv, so
  // this only ever fires for a path or a literal.
  for (const bad of ["first\nsecond", "first\r\nsecond", "ctrl\u001az"]) {
    let threw = false;
    try { windowsBatchInvocation("x.cmd", [bad], WIN_ENV); } catch { threw = true; }
    if (!threw) throw new Error(`accepted an unrepresentable argument: ${JSON.stringify(bad)}`);
  }
  let threwLong = false;
  try { windowsBatchInvocation("x.cmd", ["y".repeat(9000)], WIN_ENV); } catch { threwLong = true; }
  if (!threwLong) throw new Error("accepted a command line past what cmd.exe reads");
  ok("windowsBatchInvocation refuses what no cmd.exe command line can carry");
} catch (e) { fail("windowsBatchInvocation refusals", e.message); }

if (isWindows()) {
  // The same encoding end to end, through a shim shaped like the one npm
  // installs: `%*` sits on a line with `&`, `||` and a redirect, which is where
  // a leaked separator would have operators to attach to.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "clc-platform-"));
  try {
    const echoJs = path.join(dir, "echo-argv.mjs");
    await fsp.writeFile(echoJs, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", "utf-8");
    const shim = path.join(dir, "echo-argv.cmd");
    await fsp.writeFile(
      shim,
      [
        "@ECHO off",
        "SETLOCAL",
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "${process.execPath}"  "${echoJs}" %*`,
        "",
      ].join("\r\n"),
      "utf-8"
    );
    const canary = path.join(dir, "pwned.txt");

    try {
      const hostile = [
        "plain",
        "a b",
        `a" & echo pwned> "${canary}" & rem "b`,
        "%PATH%",
        "!PATH!",
        "100% done",
        "^ & | < > ( ) ; ,",
        "C:\\dir\\",
      ];
      const result = await runExecutable(shim, hostile, { timeoutMs: 30000 });
      if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
      const seen = JSON.parse(result.stdout);
      if (JSON.stringify(seen) !== JSON.stringify(hostile)) throw new Error(`argv round-trip: ${result.stdout}`);
      let hatched = true;
      try { await fsp.access(canary); } catch { hatched = false; }
      if (hatched) throw new Error("an argument started a second command");
      ok("runExecutable runs a .cmd and delivers hostile argv unchanged");
    } catch (e) { fail("runExecutable .cmd argv", e.message); }

    try {
      const result = await runExecutable(shim, ["first\nsecond"], { timeoutMs: 30000 });
      if (result.exitCode !== null) throw new Error(`expected a refusal, got exit ${result.exitCode}`);
      if (!/newline/.test(result.stderr)) throw new Error(`diagnostic: ${result.stderr}`);
      ok("runExecutable refuses a .cmd argument cmd.exe cannot carry");
    } catch (e) { fail("runExecutable .cmd refusal", e.message); }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
