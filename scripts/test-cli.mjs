/**
 * CLI (T12): the built `chatgpt-local-coder` binary is driven as a child
 * process against a sandboxed config directory and a sandboxed home, so no
 * assertion depends on — or disturbs — the developer's real installation.
 *
 * Three things are release gates rather than conveniences and are asserted as
 * such: `doctor --json` must parse, `config set`/`get` must round-trip through
 * the file, and an unknown command must exit non-zero with usage text. A fourth
 * is checked here too: no secret value may appear in any CLI output.
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "cli", "main.js");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-cli-"));
const home = path.join(tmp, "home");
const workspace = path.join(tmp, "workspace");
const configDir = path.join(tmp, "config");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(home, { recursive: true });

// Values that must never be echoed back by any command.
const TUNNEL_KEY = "sk-live-TUNNEL-KEY-DO-NOT-PRINT";
const ADMIN_TOKEN = "admin-TOKEN-DO-NOT-PRINT";

await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(
  path.join(configDir, "secrets.json"),
  `${JSON.stringify({ OPENAI_TUNNEL_API_KEY: TUNNEL_KEY }, null, 2)}\n`,
  { mode: 0o600 }
);

const SANDBOX = {
  CLC_CONFIG_DIR: configDir,
  CLC_STATE_DIR: path.join(tmp, "state"),
  CLC_CACHE_DIR: path.join(tmp, "cache"),
  // Both, because `os.homedir()` reads USERPROFILE on Windows and HOME elsewhere.
  HOME: home,
  USERPROFILE: home,
  WORKSPACE_PATH: workspace,
  ADMIN_TOKEN,
};

/** Run the CLI and resolve with its exit code and streams, never rejecting. */
function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: workspace,
        env: { ...process.env, ...SANDBOX, ...extraEnv },
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr, all: `${stdout}\n${stderr}` });
      }
    );
  });
}

const COMMANDS = ["init", "doctor", "up", "down", "status", "tunnel", "service", "skills", "settings", "config"];

// --------------------------------------------------------------------- help

await checkAsync("the root help lists every command and exits 0", async () => {
  const result = await run(["--help"]);
  assert(result.code === 0, `exit ${result.code}`);
  for (const command of COMMANDS) {
    assert(new RegExp(`^\\s+${command}\\s`, "m").test(result.stdout), `${command} is missing from the help`);
  }
  assert(result.stdout.includes("Usage: chatgpt-local-coder <command>"), "no usage line");
});

await checkAsync("every command answers --help without doing any work", async () => {
  for (const command of COMMANDS) {
    const result = await run([command, "--help"]);
    assert(result.code === 0, `${command} --help exited ${result.code}: ${result.stderr}`);
    assert(result.stdout.includes(`Usage: chatgpt-local-coder ${command}`), `${command}: no usage line`);
    assert(result.stdout.includes("--help"), `${command}: the help option is not documented`);
  }
});

await checkAsync("an unknown command exits non-zero with usage text", async () => {
  const result = await run(["definitely-not-a-command"]);
  assert(result.code !== 0, "an unknown command must not exit 0");
  assert(result.code === 2, `expected the usage exit code 2, got ${result.code}`);
  assert(/Unknown command: definitely-not-a-command/.test(result.stderr), `stderr: ${result.stderr}`);
  assert(/Usage: chatgpt-local-coder <command>/.test(result.stderr), "usage text should follow");
  assert(result.stdout.trim() === "", "an error belongs on stderr, not stdout");
});

await checkAsync("an unknown subcommand exits non-zero with that command's usage", async () => {
  const result = await run(["tunnel", "explode"]);
  assert(result.code === 2, `expected 2, got ${result.code}`);
  assert(/unknown tunnel subcommand "explode"/.test(result.stderr), `stderr: ${result.stderr}`);
  assert(/Usage: chatgpt-local-coder tunnel/.test(result.stderr), "the command's usage should follow");
});

await checkAsync("an unknown flag is rejected rather than ignored", async () => {
  const result = await run(["status", "--not-a-flag"]);
  assert(result.code === 2, `expected 2, got ${result.code}`);
  assert(/not-a-flag/.test(result.stderr), `stderr: ${result.stderr}`);
});

// ------------------------------------------------------------------- doctor

await checkAsync("doctor --json emits a parseable report", async () => {
  const result = await run(["doctor", "--json"]);
  const report = JSON.parse(result.stdout);

  assert(typeof report.ok === "boolean", "ok must be a boolean");
  assert(typeof report.platform === "string" && report.platform.length, "platform");
  assert(typeof report.arch === "string" && report.arch.length, "arch");
  assert(report.node === process.versions.node, `node: ${report.node}`);
  assert(path.resolve(report.paths.configFile) === path.join(configDir, "config.json"), `config file: ${report.paths.configFile}`);
  assert(Array.isArray(report.findings) && report.findings.length > 0, "findings");

  for (const finding of report.findings) {
    assert(typeof finding.id === "string" && finding.id.length, `finding without an id: ${JSON.stringify(finding)}`);
    assert(["ok", "warn", "error"].includes(finding.level), `bad level: ${finding.level}`);
    assert(typeof finding.message === "string" && finding.message.length, `finding without a message: ${finding.id}`);
  }

  // ok is exactly "no finding is at error", and the exit code follows it.
  const hasError = report.findings.some((f) => f.level === "error");
  assert(report.ok === !hasError, "ok must agree with the findings");
  assert((result.code === 0) === report.ok, `exit ${result.code} does not match ok=${report.ok}`);
});

await checkAsync("doctor reports secrets as set or unset and never prints a value", async () => {
  const result = await run(["doctor"]);
  assert(/OPENAI_TUNNEL_API_KEY=set \(file\)/.test(result.all), `store-backed secret: ${result.all}`);
  assert(/ADMIN_TOKEN=set \(env\)/.test(result.all), "environment-backed secret");
  assert(/OPENAI_TUNNEL_ID=unset/.test(result.all), "an absent secret should read unset");
  assert(!result.all.includes(TUNNEL_KEY), "the tunnel key leaked into the report");
  assert(!result.all.includes(ADMIN_TOKEN), "the admin token leaked into the report");

  const json = await run(["doctor", "--json"]);
  assert(!json.all.includes(TUNNEL_KEY), "the tunnel key leaked into the JSON report");
  assert(!json.all.includes(ADMIN_TOKEN), "the admin token leaked into the JSON report");
});

await checkAsync("doctor states that an approved shell is not sandboxed", async () => {
  const result = await run(["doctor"]);
  assert(
    /full host-user privileges/.test(result.all),
    "the shell privilege caveat must be printed, not implied"
  );
});

// ------------------------------------------------------------------- config

await checkAsync("config set and get round-trip through the file", async () => {
  const set = await run(["config", "set", "port", "4321"]);
  assert(set.code === 0, `set exited ${set.code}: ${set.stderr}`);
  assert(/port = 4321/.test(set.stdout), `set output: ${set.stdout}`);

  const get = await run(["config", "get", "port"]);
  assert(get.code === 0, `get exited ${get.code}`);
  assert(get.stdout.trim() === "4321", `get printed ${JSON.stringify(get.stdout)}`);

  const onDisk = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf-8"));
  assert(onDisk.port === 4321, `the file holds ${JSON.stringify(onDisk.port)}`);
});

await checkAsync("config set writes nested keys without dropping siblings", async () => {
  await run(["config", "set", "tunnel.alias", "acceptance-host"]);
  const get = await run(["config", "get", "tunnel.alias"]);
  assert(get.stdout.trim() === "acceptance-host", `alias: ${JSON.stringify(get.stdout)}`);

  const port = await run(["config", "get", "port"]);
  assert(port.stdout.trim() === "4321", "the earlier value should survive a later write");

  const whole = JSON.parse((await run(["config", "get", "tunnel"])).stdout);
  assert(whole.alias === "acceptance-host", "the nested object should read back whole");
});

await checkAsync("config set types values as JSON, falling back to a string", async () => {
  await run(["config", "set", "permissionProfile", "readonly"]);
  const profile = await run(["config", "get", "permissionProfile"]);
  assert(profile.stdout.trim() === "readonly", `profile: ${JSON.stringify(profile.stdout)}`);

  await run(["config", "set", "skills.allowExecution", "false"]);
  const flag = await run(["config", "get", "skills.allowExecution"]);
  assert(flag.stdout.trim() === "false", `boolean: ${JSON.stringify(flag.stdout)}`);

  await run(["config", "set", "workspaceRoots", JSON.stringify([workspace])]);
  const roots = JSON.parse((await run(["config", "get", "workspaceRoots"])).stdout);
  assert(Array.isArray(roots) && roots[0] === workspace, `roots: ${JSON.stringify(roots)}`);

  // Put the profile back so later checks see a normal host.
  await run(["config", "set", "permissionProfile", "workspace"]);
  await run(["config", "set", "skills.allowExecution", "true"]);
});

await checkAsync("config set refuses a value the schema rejects and changes nothing", async () => {
  const before = await fs.readFile(path.join(configDir, "config.json"), "utf-8");

  const bad = await run(["config", "set", "port", '"not-a-port"']);
  assert(bad.code === 1, `expected 1, got ${bad.code}`);
  assert(/Rejected: port/.test(bad.stderr), `stderr: ${bad.stderr}`);

  const badProfile = await run(["config", "set", "permissionProfile", "sudo"]);
  assert(badProfile.code === 1, `expected 1, got ${badProfile.code}`);

  const after = await fs.readFile(path.join(configDir, "config.json"), "utf-8");
  assert(before === after, "a rejected value must not touch the file");
});

await checkAsync("config get names a key it does not have", async () => {
  const result = await run(["config", "get", "no.such.key"]);
  assert(result.code === 1, `expected 1, got ${result.code}`);
  assert(/No such config key: no\.such\.key/.test(result.stderr), `stderr: ${result.stderr}`);
});

await checkAsync("config path reports the sandboxed directories", async () => {
  const result = await run(["config", "path", "--json"]);
  const paths = JSON.parse(result.stdout);
  assert(path.resolve(paths.config) === path.resolve(configDir), `config: ${paths.config}`);
  assert(path.resolve(paths.state) === path.resolve(SANDBOX.CLC_STATE_DIR), `state: ${paths.state}`);
  assert(path.resolve(paths.cache) === path.resolve(SANDBOX.CLC_CACHE_DIR), `cache: ${paths.cache}`);
  assert(paths.secrets.endsWith("secrets.json"), `secrets: ${paths.secrets}`);
});

// --------------------------------------------------------------------- init

await checkAsync("init writes a config and merges rather than replacing", async () => {
  const result = await run(["init", "--workspace", workspace, "--profile", "workspace", "--port", "4399"]);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);
  assert(result.stdout.includes(`Wrote ${path.join(configDir, "config.json")}`), `stdout: ${result.stdout}`);
  assert(result.stdout.includes("permission profile: workspace"), "the profile should be echoed");

  const alias = await run(["config", "get", "tunnel.alias"]);
  assert(alias.stdout.trim() === "acceptance-host", "init must merge into the existing config");

  const rejected = await run(["init", "--profile", "root"]);
  assert(rejected.code === 2, `an invalid profile should be a usage error, got ${rejected.code}`);
});

// ------------------------------------------------------------------- skills

await checkAsync("skills list and run work against a workspace skill", async () => {
  const dir = path.join(workspace, ".claude", "skills", "acceptance-demo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: acceptance-demo
description: Prints its arguments so the CLI can be asserted.
runtime: node
entrypoint: run.mjs
---

# Acceptance demo

Body text that \`skills read\` must print.
`,
    "utf-8"
  );
  await fs.writeFile(
    path.join(dir, "run.mjs"),
    'console.log(`demo ran with ${process.argv.slice(2).join(" ")}`);\n',
    "utf-8"
  );

  const list = await run(["skills", "list"]);
  assert(list.code === 0, `list exited ${list.code}: ${list.stderr}`);
  assert(/acceptance-demo\s+Prints its arguments/.test(list.stdout), `list output: ${list.stdout}`);

  const json = JSON.parse((await run(["skills", "list", "--json"])).stdout);
  assert(json.skills.some((s) => s.name === "acceptance-demo"), "the skill is missing from the JSON list");

  const read = await run(["skills", "read", "acceptance-demo"]);
  assert(read.stdout.includes("Body text that `skills read` must print."), "read should print the file");

  const ran = await run(["skills", "run", "acceptance-demo", "--", "--flag", "value"]);
  assert(ran.code === 0, `run exited ${ran.code}: ${ran.stderr}`);
  assert(/demo ran with --flag value/.test(ran.stdout), `run output: ${ran.stdout}`);

  const missing = await run(["skills", "read", "no-such-skill"]);
  assert(missing.code === 1, `expected 1, got ${missing.code}`);
  assert(/No skill named "no-such-skill"/.test(missing.stderr), `stderr: ${missing.stderr}`);
});

await checkAsync("skills run refuses when execution is disabled in config", async () => {
  await run(["config", "set", "skills.allowExecution", "false"]);
  try {
    const result = await run(["skills", "run", "acceptance-demo"]);
    assert(result.code !== 0, "a refused skill must not exit 0");
    assert(/allowExecution/.test(result.stderr), `stderr: ${result.stderr}`);
  } finally {
    await run(["config", "set", "skills.allowExecution", "true"]);
  }
});

// ----------------------------------------------------------------- settings

await checkAsync("settings reports what was imported and from where", async () => {
  const claude = path.join(home, ".claude");
  await fs.mkdir(claude, { recursive: true });
  await fs.writeFile(
    path.join(claude, "settings.json"),
    JSON.stringify({
      model: "claude-opus-5",
      permissions: { deny: ["Bash(rm -rf /)"], allow: ["Read(**)"] },
    }),
    "utf-8"
  );

  const result = await run(["settings", "show"]);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);
  assert(/deny\s+Bash\(rm -rf \/\)/.test(result.stdout), `deny rule missing: ${result.stdout}`);
  assert(
    /never widen the host profile/.test(result.stdout),
    "the asymmetric allow semantics must be stated in the output"
  );
  assert(/Model: claude-opus-5/.test(result.stdout), "the imported model should be reported");

  const json = JSON.parse((await run(["settings", "show", "--json"])).stdout);
  assert(json.permissions.deny.includes("Bash(rm -rf /)"), "the JSON form should carry the deny rule");

  // The adapter reads; it must never write.
  const after = JSON.parse(await fs.readFile(path.join(claude, "settings.json"), "utf-8"));
  assert(after.model === "claude-opus-5" && after.permissions.allow.length === 1, "the source file was modified");
});

// ------------------------------------------------------------------- status

await checkAsync("status --json describes a host that is not running", async () => {
  const result = await run(["status", "--json"]);
  const summary = JSON.parse(result.stdout);
  assert(summary.server.running === false, "nothing should be listening in the sandbox");
  assert(summary.server.port === 4399, `the configured port should be reported, got ${summary.server.port}`);
  assert(summary.tunnel.alias === "acceptance-host", `tunnel alias: ${summary.tunnel.alias}`);
  assert(summary.tunnel.healthy === false, "no tunnel should be healthy");
  assert(typeof summary.service.installed === "boolean", "the service state should be reported");
  assert(result.code === 1, `a stopped host should exit non-zero, got ${result.code}`);
});

// ------------------------------------------------------------------ service

await checkAsync("service --dry-run prints a unit without installing anything", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const result = await run(["service", "install", "--dry-run", "--platform", platform, "--json"]);
    assert(result.code === 0, `${platform} exited ${result.code}: ${result.stderr}`);

    const plan = JSON.parse(result.stdout);
    assert(path.isAbsolute(plan.unitPath), `${platform}: unit path is not absolute`);
    assert(plan.content.includes("--no-tunnel"), `${platform}: the unit should not manage the tunnel`);
    assert(plan.content.includes("up"), `${platform}: the unit should run \`up\``);
    assert(plan.installCommands.length >= 1, `${platform}: no install command`);

    let created = true;
    try {
      await fs.access(plan.unitPath);
    } catch {
      created = false;
    }
    assert(!created, `${platform}: --dry-run wrote ${plan.unitPath}`);
  }
});

await checkAsync("generating for another platform never installs, even without --dry-run", async () => {
  // Whatever this machine is, ask for one of the other two.
  const other = ["linux", "darwin", "win32"].filter((p) => p !== process.platform)[0];
  const result = await run(["service", "install", "--platform", other, "--json"]);
  assert(result.code === 0, `${other} exited ${result.code}: ${result.stderr}`);

  const plan = JSON.parse(result.stdout);
  assert(plan.mechanism && plan.content, "a cross-platform request should return a plan, not an install result");
  assert(plan.commandResults === undefined, "nothing may have been executed");

  let created = true;
  try {
    await fs.access(plan.unitPath);
  } catch {
    created = false;
  }
  assert(!created, `${other}: ${plan.unitPath} was written`);
});

await checkAsync("service status reports rather than installs", async () => {
  const result = await run(["service", "status", "--json"]);
  const status = JSON.parse(result.stdout);
  assert(status.installed === false, "nothing should be installed in the sandbox");
  assert(typeof status.mechanism === "string", `mechanism: ${status.mechanism}`);
  assert(result.code === 1, `a missing service should exit non-zero, got ${result.code}`);
});

// ------------------------------------------------------------------ version

await checkAsync("version prints the package version", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8"));
  const result = await run(["--version"]);
  assert(result.code === 0, `exit ${result.code}`);
  assert(result.stdout.trim() === pkg.version, `printed ${JSON.stringify(result.stdout)}`);
  assert(pkg.bin["chatgpt-local-coder"] === "dist/cli/main.js", "the package must expose the CLI binary");
  assert(pkg.bin.clc === "dist/cli/main.js", "the short alias should point at the same entry");
});

// -------------------------------------------------------------------- secrets

/** Like `run`, but feeds the child stdin — how a value is meant to arrive. */
function runWithStdin(args, input) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: workspace, env: { ...process.env, ...SANDBOX }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr, all: `${stdout}\n${stderr}` });
      }
    );
    child.stdin.end(input);
  });
}

await checkAsync("secrets path prints the store location", async () => {
  const result = await run(["secrets", "path"]);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);
  assert(
    result.stdout.trim() === path.join(configDir, "secrets.json"),
    `printed ${result.stdout.trim()}`
  );
});

await checkAsync("secrets list reports state and source but never a value", async () => {
  const result = await run(["secrets", "list"]);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);
  assert(/OPENAI_TUNNEL_API_KEY\s+set/.test(result.stdout), "stored key not reported as set");
  assert(!result.all.includes(TUNNEL_KEY), "the key value leaked into output");
  // ADMIN_TOKEN is exported in this sandbox, and the environment wins.
  assert(/ADMIN_TOKEN\s+set\s+environment/.test(result.stdout), "env source not reported");
  assert(!result.all.includes(ADMIN_TOKEN), "the admin token leaked into output");
});

// A value in argv is readable through `ps` and lands in shell history, so the
// command has to refuse it rather than quietly accept a compromised secret.
await checkAsync("secrets set refuses a value passed as an argument", async () => {
  const leaked = "sk-live-ARGV-LEAK";
  const result = await run(["secrets", "set", "OPENAI_TUNNEL_ID", leaked]);
  assert(result.code === 2, `expected usage exit 2, got ${result.code}`);
  assert(/must not be passed as an argument/.test(result.all), `unexpected message: ${result.all}`);
  assert(/ps.*shell history|shell history/.test(result.all), "no rationale given");

  const store = JSON.parse(await fs.readFile(path.join(configDir, "secrets.json"), "utf-8"));
  assert(store.OPENAI_TUNNEL_ID === undefined, "the rejected value was stored anyway");
});

await checkAsync("secrets set stores a piped value and reports only its length", async () => {
  const value = "tun_PIPED_VALUE_DO_NOT_PRINT";
  const result = await runWithStdin(["secrets", "set", "OPENAI_TUNNEL_ID", "--stdin"], `${value}\n`);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);
  assert(!result.all.includes(value), "the stored value was echoed back");
  assert(result.all.includes(`${value.length} characters`), `no length report: ${result.all}`);

  const store = JSON.parse(await fs.readFile(path.join(configDir, "secrets.json"), "utf-8"));
  // The trailing newline a paste drags along must not become part of the key.
  assert(store.OPENAI_TUNNEL_ID === value, `stored ${JSON.stringify(store.OPENAI_TUNNEL_ID)}`);
  assert(store.OPENAI_TUNNEL_API_KEY === TUNNEL_KEY, "writing one secret clobbered another");

  if (process.platform !== "win32") {
    const mode = (await fs.stat(path.join(configDir, "secrets.json"))).mode & 0o777;
    assert(mode === 0o600, `store mode is ${mode.toString(8)}, expected 600`);
  }
});

await checkAsync("secrets delete removes one entry and leaves the rest", async () => {
  const result = await run(["secrets", "delete", "OPENAI_TUNNEL_ID"]);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);

  const store = JSON.parse(await fs.readFile(path.join(configDir, "secrets.json"), "utf-8"));
  assert(store.OPENAI_TUNNEL_ID === undefined, "entry survived deletion");
  assert(store.OPENAI_TUNNEL_API_KEY === TUNNEL_KEY, "deletion removed an unrelated entry");
});

// ------------------------------------------------------- global install shape

// `npm i -g` and `npm link` put a *symlink* in the bin directory on Linux and
// macOS, so the entry point is reached through a path that is not its own. A
// main-module guard that compares unresolved paths silently does nothing here:
// exit 0, no output. That is the shape this asserts, not the guard's source.
await checkAsync("the CLI still runs when reached through a symlink, as a global install does", async () => {
  const binDir = path.join(tmp, "npm-bin");
  await fs.mkdir(binDir, { recursive: true });
  const link = path.join(binDir, process.platform === "win32" ? "clc-link.js" : "clc-link");
  await fs.symlink(CLI, link);

  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [link, "--version"],
      { cwd: workspace, env: { ...process.env, ...SANDBOX }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8"));
  assert(result.stdout.trim() !== "", "the symlinked CLI produced no output at all");
  assert(result.stdout.trim() === pkg.version, `printed ${JSON.stringify(result.stdout)}`);
  assert(result.code === 0, `exit ${result.code}: ${result.stderr}`);
});

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
