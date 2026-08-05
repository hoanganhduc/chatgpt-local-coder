/**
 * Global shell cwd persists across bootstrap (simulates ChatGPT new MCP sessions).
 *
 * The state directory is set BEFORE importing the module under test: ESM
 * hoists static imports, so a plain `import` would run before the assignment
 * and the module would capture the default state directory instead. That made
 * this test non-idempotent — the second run inherited the first run's saved
 * cwd and tried to `cd src` from inside src.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-shell-state-"));

process.env.MCP_SHELL_STATE_DIR = stateDir;

const { bootstrapShellSession, execInShellSession, getShellStatus } = await import(
  "../dist/lib/persistent-shell.js"
);

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  const { loadGlobalShellState } = await import("../dist/lib/global-shell-state.js");
  if (await loadGlobalShellState(root, root) !== null) {
    throw new Error(`state directory ${stateDir} was not honoured — the test is not isolated`);
  }
  ok("the test runs against an isolated, empty shell-state directory");
} catch (e) { fail("state isolation", e.message || e); }

try {
  await bootstrapShellSession(root);
  await execInShellSession("cd src", root, 5000);

  const cwd1 = getShellStatus().cwd;
  if (!cwd1.replace(/\\/g, "/").endsWith("/src")) {
    throw new Error(`expected cwd in src, got ${cwd1}`);
  }
  ok(`cwd after cd: ${cwd1}`);

  await bootstrapShellSession(root);
  const cwd2 = getShellStatus().cwd;
  if (cwd2 !== cwd1) throw new Error(`persist failed: ${cwd1} -> ${cwd2}`);
  ok("cwd restored after re-bootstrap");
} catch (e) {
  fail("shell persist", e.message || e);
}

// ------------------------------------------------ what a command can do to us
//
// `run_command` is the one tool a model reaches for constantly, and until this
// was fixed a single command could end the server two ways: by printing more
// than a JavaScript string can hold, and by leaving something running that held
// the stdout pipe open so the call never returned. Both fixtures are Node
// scripts rather than shell so the same command runs on every supported OS.

const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-shell-cmd-"));

try {
  const noisy = path.join(fixtureDir, "noisy.mjs");
  await fs.writeFile(
    noisy,
    "const chunk = 'x'.repeat(1024 * 64);\nfor (let i = 0; i < 128; i++) process.stdout.write(chunk);\n",
    "utf-8"
  );

  const result = await execInShellSession(`node "${noisy}"`, root, 60000);
  if (result.exit_code !== 0) throw new Error(`exit ${result.exit_code}: ${result.stderr}`);
  if (result.stdout.length > 4_000_000) {
    throw new Error(`kept ${result.stdout.length} chars of an 8MB command`);
  }
  if (result.truncated !== true) throw new Error("output was dropped without saying so");
  ok("run_command bounds the output one command can accumulate");
} catch (e) { fail("run_command output cap", e.message || e); }

try {
  const backgrounder = path.join(fixtureDir, "background.mjs");
  const pidFile = path.join(fixtureDir, "leaf.pid");
  await fs.writeFile(
    backgrounder,
    [
      'import { spawn } from "child_process";',
      'import fs from "fs";',
      "const [, , pidFile] = process.argv;",
      "// `inherit` hands the leaf this process's own stdout, so the pipe stays",
      "// open after this process exits — which is what `close` waits for.",
      'const leaf = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25000)"], { stdio: "inherit" });',
      "fs.writeFileSync(pidFile, String(leaf.pid));",
      "leaf.unref();",
    ].join("\n"),
    "utf-8"
  );

  const started = Date.now();
  const outcome = await Promise.race([
    execInShellSession(`node "${backgrounder}" "${pidFile}"`, root, 30000).then((result) => ({ result })),
    new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
  ]);
  const leaf = Number(await fs.readFile(pidFile, "utf-8").catch(() => "0"));
  if (leaf) { try { process.kill(leaf, "SIGKILL"); } catch { /* already gone */ } }

  if (!outcome) throw new Error(`still pending ${Date.now() - started}ms after the command exited`);
  if (outcome.result.exit_code !== 0) throw new Error(`exit ${outcome.result.exit_code}`);
  ok("a command that leaves something running still returns when it exits");
} catch (e) { fail("run_command background process", e.message || e); }

await fs.rm(fixtureDir, { recursive: true, force: true });
await fs.rm(stateDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
