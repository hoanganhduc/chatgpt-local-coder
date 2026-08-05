/**
 * Verify the platform adapter reports this host correctly and produces a
 * runnable shell spec on every supported OS.
 */
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
