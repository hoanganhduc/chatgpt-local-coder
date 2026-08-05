/**
 * Verify the platform adapter reports this host correctly and produces a
 * runnable shell spec on every supported OS.
 */
import os from "os";
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
  ok("runExecutable reports failure for a missing binary instead of throwing");
} catch (e) { fail("runExecutable missing binary", e.message); }

try {
  const shell = defaultShell();
  const result = await runExecutable(shell.command, shell.args("echo platform-shell-ok"), { timeoutMs: 30000 });
  if (result.exitCode !== 0) throw new Error(`shell exit ${result.exitCode}: ${result.stderr}`);
  if (!result.stdout.includes("platform-shell-ok")) throw new Error(`shell stdout ${JSON.stringify(result.stdout)}`);
  ok("defaultShell actually executes a command on this host");
} catch (e) { fail("defaultShell execution", e.message); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
