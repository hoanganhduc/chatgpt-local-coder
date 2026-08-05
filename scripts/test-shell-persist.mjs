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

await fs.rm(stateDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
