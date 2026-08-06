/**
 * Bounds on the git subprocess.
 *
 * Both call sites used to spawn git themselves and append everything it printed
 * to a string with no ceiling and with no deadline. The first is the shape that
 * ended the server from `run_command`; the second is what let a slow pre-commit
 * hook wedge a tool call for as long as it liked.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";

const { runGit } = await import("../dist/lib/git-run.js");
const { collectGitSnapshot } = await import("../dist/lib/git-snapshot.js");

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e?.message || e}`); failed++; }

const repo = await fs.mkdtemp(path.join(os.tmpdir(), "clc-git-"));
/** Somewhere that is deliberately not a repository. */
const bare = await fs.mkdtemp(path.join(os.tmpdir(), "clc-nogit-"));

/** CI has no git identity, so every commit carries its own. */
const commit = (args, opts) =>
  runGit(["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", ...args], repo, opts);

/** Hooks run from the repository root, and Git for Windows runs them too. */
async function writeHook(body) {
  const hook = path.join(repo, ".git", "hooks", "pre-commit");
  await fs.writeFile(hook, `#!/bin/sh\n${body}\n`, "utf-8");
  await fs.chmod(hook, 0o755);
}

try {
  const init = await runGit(["init"], repo);
  if (init.not_found) throw new Error("git is not installed, so nothing below can run");
  if (init.exit_code !== 0) throw new Error(`git init: ${init.stderr}`);

  // ------------------------------------------------------------------ hooks

  // Not a regression test: closing stdin is new, and this is what would break
  // if closing it were wrong. A hook that reads stdin is the case at risk, and
  // it survives because git redirects hook stdin from /dev/null itself — the
  // handle this host closes never reaches the hook at all.
  await run("a hook that reads stdin still runs, and the commit still succeeds", async () => {
    // `read` returns non-zero at EOF, which would abort the commit, so the hook
    // tolerates that and leaves a marker: a hook that never ran would otherwise
    // let this pass silently.
    await writeHook('read line || true\n: > hook-ran.txt');
    const started = Date.now();
    const result = await commit(["--allow-empty", "-m", "first"]);
    const elapsed = Date.now() - started;

    if (result.timed_out) throw new Error(`the commit ran out its deadline after ${elapsed}ms`);
    if (result.exit_code !== 0) throw new Error(`exit ${result.exit_code}: ${result.stderr}`);
    await fs.access(path.join(repo, "hook-ran.txt")).catch(() => {
      throw new Error("the hook never ran, so this proved nothing");
    });
  });

  // ------------------------------------------------------------------- cap

  await run("runGit bounds what one git command can print", async () => {
    // A commit message is the cheapest way to make git print megabytes: no
    // thousands of files to create, and `%B` reads it straight back out.
    const huge = path.join(repo, "message.txt");
    await fs.writeFile(huge, "x".repeat(3 * 1024 * 1024), "utf-8");
    await writeHook("exit 0");
    const made = await commit(["--allow-empty", "-F", huge]);
    if (made.exit_code !== 0) throw new Error(`commit: ${made.stderr}`);

    const log = await runGit(["log", "-1", "--format=%B"], repo);
    // The cap is 2 MB and the allowance here is thousands of characters, not a
    // chunk's worth. A cap enforced only between chunks passes a loose bound on
    // Linux, where a pipe arrives in 64KB pieces, while keeping a 3MB Windows
    // chunk whole — so a loose bound would have made this a Windows-only test
    // that nobody watching Linux ever sees break.
    if (log.stdout.length > 2_005_000) throw new Error(`kept ${log.stdout.length} chars of a 3MB message`);
    if (!/truncated/.test(log.stdout)) throw new Error("truncation happened without saying so");
  });

  // -------------------------------------------------------------- snapshot

  await run("the session snapshot still reads a repository, and knows when there is none", async () => {
    const snapshot = await collectGitSnapshot(repo);
    if (!snapshot.is_repo) throw new Error(`reported not a repo: ${snapshot.error}`);
    if (!snapshot.branch) throw new Error("no branch reported");
    // git ends the branch name with a newline and this reaches the session
    // instructions as a name rather than as a line, which is a property of the
    // shared runner rather than of anything here — so it is pinned, not assumed.
    if (snapshot.branch !== snapshot.branch.trim()) throw new Error(`branch was ${JSON.stringify(snapshot.branch)}`);
    if (!snapshot.recent_commits?.length) throw new Error("no commits reported");

    const none = await collectGitSnapshot(bare);
    if (none.is_repo) throw new Error(`${bare} is not a repository`);
  });

  // -------------------------------------------------------------- deadline

  // Last: killing git mid-commit can leave an index.lock behind, and every
  // commit after it in this repository would fail for that reason instead.
  await run("a hook that never returns is bounded by the deadline", async () => {
    await writeHook("sleep 30");
    const started = Date.now();
    const result = await commit(["--allow-empty", "-m", "slow"], { timeoutMs: 2000 });
    const elapsed = Date.now() - started;

    if (!result.timed_out) throw new Error(`exit ${result.exit_code} after ${elapsed}ms, deadline not reported`);
    if (elapsed > 15000) throw new Error(`settled ${elapsed}ms after a 2s deadline`);
    if (!/timed out/.test(result.stderr)) throw new Error(`said instead: ${JSON.stringify(result.stderr)}`);
    if (result.exit_code === 0) throw new Error("a killed git reported success");
  });
} catch (error) {
  fail("git fixture", error);
}

await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
await fs.rm(bare, { recursive: true, force: true }).catch(() => undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}
