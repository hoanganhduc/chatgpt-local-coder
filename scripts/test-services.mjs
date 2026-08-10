/**
 * Service generators (T11): the systemd user unit, the LaunchAgent and the
 * schtasks logon task are asserted as strings for all three platforms from
 * whichever platform is running this file.
 *
 * Nothing here installs anything. `servicePlan` takes the platform and the home
 * directory as parameters precisely so the generated content can be checked
 * without touching the machine's real service manager.
 */
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  LABEL,
  isOwnedWindowsTask,
  installService,
  launchdPlistPath,
  renderLaunchAgent,
  renderSystemdUnit,
  renderTaskXml,
  renderWindowsPowerShellPredecessorTaskXml,
  servicePlan,
  stopService,
  systemdUnitPath,
  TASK_NAME,
  TASK_OWNERSHIP_MARKER,
  taskXmlPath,
  UNIT_NAME,
  uninstallService,
  rotateServerLog,
  WINDOWS_LAUNCHER_SOURCE,
  windowsLauncherCompileCommand,
  windowsLauncherExecutablePath,
  windowsLauncherSourcePath,
  windowsTaskQueryCommand,
} from "../dist/services/index.js";
import { runExecutable } from "../dist/lib/platform.js";

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
function includes(haystack, needle, what) {
  assert(haystack.includes(needle), `${what}: missing ${JSON.stringify(needle)}`);
}
function xmlDecode(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
function xmlEncode(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function taskAction(task) {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(task)?.[1] ?? "";
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(task)?.[1] ?? "";
  return { command: xmlDecode(command), args: xmlDecode(args) };
}
function decodedTaskScript(task) {
  const { args } = taskAction(task);
  const encoded = /(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)$/.exec(args)?.[1];
  assert(encoded, `missing EncodedCommand: ${args}`);
  return Buffer.from(encoded, "base64").toString("utf16le");
}
function taskPayload(task) {
  const script = decodedTaskScript(task);
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1];
  assert(encoded, `missing encoded payload: ${script}`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
}
function nativeTaskPayload(task) {
  const { args } = taskAction(task);
  const bytes = Buffer.from(args, "base64");
  let offset = 0;
  const magic = bytes.subarray(offset, offset += 4).toString("ascii");
  assert(magic === "CLC2", `native payload magic: ${magic}`);
  const readField = () => {
    const length = bytes.readInt32LE(offset); offset += 4;
    const value = bytes.subarray(offset, offset += length).toString("utf-8");
    return value;
  };
  const payload = {
    execPath: readField(),
    argumentLine: readField(),
    workingDirectory: readField(),
    logPath: readField(),
    env: {},
  };
  const environmentCount = bytes.readInt32LE(offset); offset += 4;
  for (let index = 0; index < environmentCount; index++) payload.env[readField()] = readField();
  assert(offset === bytes.length, `native payload has ${bytes.length - offset} trailing bytes`);
  return payload;
}
function launcherCompilePaths(args) {
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  assert(encoded, `missing launcher compiler EncodedCommand: ${args.join(" ")}`);
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1];
  assert(payload, `missing launcher compiler path payload: ${script}`);
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}
function commandRun({ exitCode = 0, stdout = "", stderr = "", spawnFailed = false, truncated = false } = {}) {
  return { exitCode, stdout, stderr, spawnFailed, truncated, timedOut: false };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-services-"));
const home = path.join(tmp, "home");

// A spec whose values are all absolute and all distinguishable in the output.
const NODE = process.execPath;
const ENTRY = path.join(tmp, "app", "dist", "cli", "main.js");
const WORKDIR = path.join(tmp, "workspace");
const LOG = path.join(tmp, "state", "server.log");

const spec = {
  execPath: NODE,
  args: [ENTRY, "up", "--no-tunnel"],
  workingDirectory: WORKDIR,
  description: "chatgpt-local-coder MCP host",
  logPath: LOG,
  env: { CLC_CONFIG_DIR: path.join(tmp, "config"), NODE_ENV: "production" },
};

const nativeLauncherHome = path.join(tmp, "native-launcher-home");
async function compileNativeLauncherFixture() {
  const source = windowsLauncherSourcePath(nativeLauncherHome);
  const executable = windowsLauncherExecutablePath(nativeLauncherHome);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, WINDOWS_LAUNCHER_SOURCE, "utf-8");
  try {
    await fs.access(executable);
    return executable;
  } catch {}
  const [command, args] = windowsLauncherCompileCommand(source, executable);
  const result = await runExecutable(command, args, { cwd: tmp, timeoutMs: 60_000 });
  assert(result.exitCode === 0, `native launcher compile exit ${result.exitCode}: ${result.stderr}`);
  await fs.access(executable);
  return executable;
}
async function emulateSuccessfulLauncherCompile(args) {
  const compiledFixture = await compileNativeLauncherFixture();
  const { outputPath } = launcherCompilePaths(args);
  await fs.copyFile(compiledFixture, outputPath);
}
async function readStagedTaskXml(fakeHome) {
  return (await fs.readFile(taskXmlPath(fakeHome))).toString("utf16le").replace(/^\uFEFF/, "");
}
function currentWindowsIdentity() {
  const whoami = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  const output = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const match = /^"((?:[^"]|"")*)","(S-1-(?:\d+-)+\d+)"$/i.exec(output);
  assert(match, `unexpected whoami identity: ${output}`);
  return { account: match[1].replace(/""/g, '"'), sid: match[2] };
}

// ----------------------------------------------------------------- systemd

check("the systemd unit is a user unit at the documented path", () => {
  const plan = servicePlan(spec, "linux", home);
  assert(plan.mechanism === "systemd-user", `mechanism: ${plan.mechanism}`);
  assert(
    plan.unitPath === path.join(home, ".config", "systemd", "user", UNIT_NAME),
    `unit path: ${plan.unitPath}`
  );
  assert(plan.unitPath === systemdUnitPath(home), "the plan and the helper must agree");
  assert(UNIT_NAME.endsWith(".service"), "systemd units end in .service");
});

check("the systemd unit carries absolute paths, the environment, and the log", () => {
  const unit = renderSystemdUnit(spec);
  const quote = (value) => value.includes(" ") ? `"${value}"` : value;
  includes(unit, `ExecStart=${quote(NODE)} ${quote(ENTRY)} up --no-tunnel`, "ExecStart");
  includes(unit, `WorkingDirectory=${WORKDIR}`, "WorkingDirectory");
  includes(unit, `Environment="CLC_CONFIG_DIR=${path.join(tmp, "config")}"`, "config dir");
  includes(unit, `Environment="NODE_ENV=production"`, "node env");
  includes(unit, `StandardOutput=append:${LOG}`, "stdout");
  includes(unit, `StandardError=append:${LOG}`, "stderr");
  includes(unit, "Description=chatgpt-local-coder MCP host", "description");
  includes(unit, "Restart=on-failure", "restart policy");
  includes(unit, "WantedBy=default.target", "install target");
  assert(!/WantedBy=multi-user\.target/.test(unit), "a user unit must not target multi-user");
});

check("systemd quoting survives spaces in argv and quotes in the environment", () => {
  const spaced = {
    ...spec,
    args: [path.join(tmp, "a dir", "main.js"), "up"],
    env: { QUOTED: 'a "quoted" value' },
  };
  const unit = renderSystemdUnit(spaced);
  includes(unit, `"${path.join(tmp, "a dir", "main.js")}"`, "spaced argument");
  includes(unit, 'Environment="QUOTED=a \\"quoted\\" value"', "escaped quotes");
});

check("the systemd commands are all --user scoped", () => {
  const plan = servicePlan(spec, "linux", home);
  const all = [...plan.installCommands, ...plan.uninstallCommands, ...plan.stopCommands, plan.statusCommand];
  for (const [command, args] of all) {
    assert(command === "systemctl", `unexpected command: ${command}`);
    assert(args[0] === "--user", `not user-scoped: systemctl ${args.join(" ")}`);
  }
  assert(plan.notes.some((n) => /linger/.test(n)), "the logout caveat should be stated");
});

// ----------------------------------------------------------------- launchd

check("the LaunchAgent is a per-user agent at the documented path", () => {
  const plan = servicePlan(spec, "darwin", home);
  assert(plan.mechanism === "launchd-agent", `mechanism: ${plan.mechanism}`);
  assert(plan.unitPath === path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`), `path: ${plan.unitPath}`);
  assert(plan.unitPath === launchdPlistPath(home), "the plan and the helper must agree");
  assert(!plan.unitPath.includes("LaunchDaemons"), "a daemon would run as root");
});

check("the LaunchAgent lists argv in order with the environment and log paths", () => {
  const plist = renderLaunchAgent(spec);
  const argv = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert(argv[0] === LABEL, `the label comes first: ${argv[0]}`);
  assert(argv[1] === NODE, `exec path: ${argv[1]}`);
  assert(argv[2] === ENTRY, `entry point: ${argv[2]}`);
  assert(argv[3] === "up" && argv[4] === "--no-tunnel", "the remaining argv");

  includes(plist, `<key>CLC_CONFIG_DIR</key>`, "config dir key");
  includes(plist, `<string>${path.join(tmp, "config")}</string>`, "config dir value");
  includes(plist, `<key>NODE_ENV</key>`, "node env key");
  includes(plist, `<key>StandardOutPath</key>\n  <string>${LOG}</string>`, "stdout path");
  includes(plist, `<key>StandardErrorPath</key>\n  <string>${LOG}</string>`, "stderr path");
  includes(plist, "<key>RunAtLoad</key>\n  <true/>", "run at load");
  includes(plist, '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"', "doctype");
});

check("the LaunchAgent escapes XML metacharacters", () => {
  const plist = renderLaunchAgent({ ...spec, description: 'a & b', workingDirectory: "/tmp/<dir>" });
  includes(plist, "<string>/tmp/&lt;dir&gt;</string>", "escaped working directory");
  assert(!/<string>[^<]*[<>&][^<]*<\/string>/.test(plist.replace(/&(amp|lt|gt|quot|apos);/g, "")),
    "no raw metacharacter should survive inside a string element");
});

check("the launchd commands are gui-domain, not system-domain", () => {
  const plan = servicePlan(spec, "darwin", home);
  const all = [...plan.installCommands, ...plan.uninstallCommands, ...plan.stopCommands, plan.statusCommand];
  for (const [command, args] of all) {
    assert(command === "launchctl", `unexpected command: ${command}`);
    assert(args.some((a) => a.startsWith("gui/")), `not gui-scoped: launchctl ${args.join(" ")}`);
    assert(!args.some((a) => a.startsWith("system/")), `system domain requires root: ${args.join(" ")}`);
  }
  assert(plan.notes.some((n) => /bootstrap/.test(n)), "the bootstrap-vs-load note should be stated");
});

// ----------------------------------------------------------------- windows

check("the Windows task is a logon task at the documented path", () => {
  const plan = servicePlan(spec, "win32", home);
  assert(plan.mechanism === "schtasks-logon", `mechanism: ${plan.mechanism}`);
  assert(
    plan.unitPath === path.join(home, "AppData", "Local", "chatgpt-local-coder", `${TASK_NAME}.xml`),
    `path: ${plan.unitPath}`
  );
  assert(plan.unitPath === taskXmlPath(home), "the plan and the helper must agree");
});

check("the Windows task crosses a GUI-subsystem launcher boundary", () => {
  const task = renderTaskXml(spec);
  const { command } = taskAction(task);
  assert(path.win32.isAbsolute(command), `launcher path is not absolute: ${command}`);
  assert(
    /^ChatGPTLocalCoderLauncher-[a-f0-9]{64}\.exe$/i.test(path.win32.basename(command)),
    `launcher is not the content-addressed native executable: ${command}`
  );
  assert(!/(?:powershell|cmd|node|wscript|cscript)\.exe$/i.test(command), `non-native launcher selected: ${command}`);
  includes(task, "<Hidden>false</Hidden>", "the task must remain visible in Task Scheduler");
  const payload = nativeTaskPayload(task);
  assert(payload.execPath === NODE, `runtime child is not Node: ${payload.execPath}`);
  assert(!/powershell\.exe$/i.test(payload.execPath), `runtime payload still targets PowerShell: ${payload.execPath}`);
  assert(payload.argumentLine.includes("--no-tunnel"), `runtime argv missing: ${payload.argumentLine}`);
  assert(JSON.stringify(payload.env) === JSON.stringify(spec.env), `runtime environment: ${JSON.stringify(payload.env)}`);
});

check("the task XML carries an opaque direct-native launcher payload", () => {
  const task = renderTaskXml(spec);
  includes(task, '<?xml version="1.0" encoding="UTF-16"?>', "schtasks requires the UTF-16 declaration");
  includes(task, `<WorkingDirectory>${WORKDIR}</WorkingDirectory>`, "working directory");
  includes(task, "<LogonTrigger>", "logon trigger");
  includes(task, "<RunLevel>LeastPrivilege</RunLevel>", "no elevation");
  includes(task, TASK_OWNERSHIP_MARKER, "stable task ownership marker");

  const { command, args } = taskAction(task);
  assert(path.win32.isAbsolute(command), `native launcher path is not absolute: ${command}`);
  assert(/^[A-Za-z0-9+/=]+$/.test(args), `arguments are not one opaque payload: ${args}`);
  const payload = nativeTaskPayload(task);
  assert(payload.execPath === NODE, `exec path: ${payload.execPath}`);
  assert(typeof payload.argumentLine === "string" && payload.argumentLine.includes("--no-tunnel"), `arguments: ${payload.argumentLine}`);
  assert(payload.workingDirectory === WORKDIR, `working directory: ${payload.workingDirectory}`);
  assert(JSON.stringify(payload.env) === JSON.stringify(spec.env), `environment: ${JSON.stringify(payload.env)}`);
});

check("the task keeps environment values and argv opaque until native payload decoding", () => {
  const hostile = {
    ...spec,
    args: [String.raw`C:\safe&pipe|redirect<in>out^caret(100%)!bang"quote\main.js`, "up"],
    env: { CLC_CONFIG_DIR: String.raw`C:\config&pipe|redirect<in>out^caret(100%)!bang"quote`, NODE_ENV: "production" },
  };
  const task = renderTaskXml(hostile);
  const { args } = taskAction(task);
  for (const value of [hostile.execPath, ...hostile.args, ...Object.values(hostile.env)]) {
    assert(!args.includes(value), `raw value reached task arguments: ${JSON.stringify(value)}`);
  }
  const payload = nativeTaskPayload(task);
  assert(payload.execPath === hostile.execPath, `exec path: ${payload.execPath}`);
  assert(payload.workingDirectory === hostile.workingDirectory, `working directory: ${payload.workingDirectory}`);
  assert(payload.argumentLine.includes("pipe|redirect"), `argument line: ${payload.argumentLine}`);
  assert(JSON.stringify(payload.env) === JSON.stringify(hostile.env), `environment: ${JSON.stringify(payload.env)}`);
});

check("Windows task ownership requires an exact structured action", () => {
  const owned = renderTaskXml(spec);
  assert(isOwnedWindowsTask(owned, spec), "current marker-bearing task was not recognized");
  let schedulerNormalized;
  if (process.platform === "win32") {
    const identity = currentWindowsIdentity();
    schedulerNormalized = owned
      .replace(`<UserId>${os.userInfo().username}</UserId>`, `<UserId>${identity.sid}</UserId>`)
      .replace(`<UserId>${os.userInfo().username}</UserId>`, `<UserId>${identity.account}</UserId>`)
      .replace("      <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("    <Hidden>false</Hidden>\n", "");
    assert(isOwnedWindowsTask(schedulerNormalized, spec), "Task Scheduler's SID/domain/default normalization was not recognized");
    assert(
      !isOwnedWindowsTask(schedulerNormalized.replace(identity.account, "TESTHOST\\another-user"), spec),
      "normalized task for another account was accepted"
    );
    assert(
      !isOwnedWindowsTask(schedulerNormalized.replace(identity.sid, "S-1-5-21-1-2-3-1001"), spec),
      "normalized task for another SID was accepted"
    );
  }
  assert(
    !isOwnedWindowsTask(owned.replace("</Actions>", "<Exec><Command>C:\\attacker.exe</Command></Exec></Actions>"), spec),
    "task with an additional executable action was accepted"
  );
  assert(
    !isOwnedWindowsTask(owned.replace("</Triggers>", "<TimeTrigger><Enabled>true</Enabled></TimeTrigger></Triggers>"), spec),
    "task with an additional trigger was accepted"
  );
  assert(
    isOwnedWindowsTask(owned.replace("    <Hidden>false</Hidden>\n", ""), spec),
    "live XML with Task Scheduler's omitted visible Hidden field was not recognized"
  );
  assert(
    !isOwnedWindowsTask(owned.replace("<Hidden>false</Hidden>", "<Hidden>true</Hidden>"), spec),
    "current action with hidden task metadata was accepted"
  );
  assert(
    !isOwnedWindowsTask(owned.replace("<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>"), spec),
    "current action with a forged principal was accepted"
  );
  const forgedAction = owned.replace(/<Command>[\s\S]*?<\/Command>/, "<Command>C:\\attacker\\payload.exe</Command>");
  assert(!isOwnedWindowsTask(forgedAction, spec), "marker alone accepted a forged action");
  const scattered = `<Task><Description>other</Description><Command>other.exe</Command><Arguments>${TASK_OWNERSHIP_MARKER} ${xmlEncode(NODE)} --no-tunnel</Arguments><WorkingDirectory>${xmlEncode(WORKDIR)}</WorkingDirectory></Task>`;
  assert(!isOwnedWindowsTask(scattered, spec), "scattered ownership substrings were accepted");

  const schemaV1 = renderWindowsPowerShellPredecessorTaskXml(spec, "schema-v1");
  const installedHidden = renderWindowsPowerShellPredecessorTaskXml(spec, "installed-window-hidden");
  assert(isOwnedWindowsTask(schemaV1, spec), "exact schema-v1 PowerShell predecessor was not recognized");
  includes(schemaV1, ` — ${TASK_OWNERSHIP_MARKER}`, "released schema-v1 em-dash description");
  assert(isOwnedWindowsTask(installedHidden, spec), "exact installed WindowStyle predecessor was not recognized");
  assert(
    isOwnedWindowsTask(installedHidden.replace("    <Hidden>false</Hidden>\n", ""), spec),
    "live-normalized installed WindowStyle predecessor was not recognized"
  );
  assert(
    !isOwnedWindowsTask(installedHidden.replace(` - ${TASK_OWNERSHIP_MARKER}`, ` — ${TASK_OWNERSHIP_MARKER}`), spec),
    "hybrid predecessor description/payload was accepted"
  );
  assert(
    !isOwnedWindowsTask(installedHidden.replace(" -WindowStyle Hidden", ""), spec),
    "hybrid predecessor without the installed WindowStyle field was accepted"
  );
  assert(
    !isOwnedWindowsTask(installedHidden.replace("<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>"), spec),
    "historical action with a forged principal was accepted"
  );
  if (schedulerNormalized) {
    const identity = currentWindowsIdentity();
    const normalizedPredecessor = installedHidden
      .replace(`<UserId>${os.userInfo().username}</UserId>`, `<UserId>${identity.sid}</UserId>`)
      .replace(`<UserId>${os.userInfo().username}</UserId>`, `<UserId>${identity.account}</UserId>`)
      .replace("      <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("    <Hidden>false</Hidden>\n", "");
    assert(isOwnedWindowsTask(normalizedPredecessor, spec), "live-normalized WindowStyle predecessor was not recognized");
  }

  const legacyEnv = Object.entries(spec.env).map(([key, value]) => `set ${key}=${value}&& `).join("");
  const legacyArgs = spec.args.map((part) => part.includes(" ") ? `"${part}"` : part).join(" ");
  const legacy = `<Task><RegistrationInfo><Description>${xmlEncode(spec.description)}</Description></RegistrationInfo><Actions><Exec><Command>cmd.exe</Command><Arguments>${xmlEncode(`/c ${legacyEnv}"${spec.execPath}" ${legacyArgs}`)}</Arguments><WorkingDirectory>${xmlEncode(spec.workingDirectory)}</WorkingDirectory></Exec></Actions></Task>`;
  assert(!isOwnedWindowsTask(legacy, spec), "pre-marker task without a complete envelope was accepted");
});

await checkAsync("the native Windows launcher preserves argv and environment without executing metacharacters", async () => {
  if (process.platform !== "win32") return;
  await compileNativeLauncherFixture();
  const probe = path.join(tmp, "task-probe.mjs");
  await fs.writeFile(
    probe,
    'process.stdout.write(JSON.stringify({ env: process.env.CLC_TASK_PROBE, args: process.argv.slice(2) }));\n',
    "utf-8"
  );
  const expected = {
    env: String.raw`env&pipe|redirect<in>out^caret(100%)!bang"quote`,
    args: [
      "",
      'a"b',
      "two words",
      "space and trailing slash\\",
      String.raw`x\" y`,
      String.raw`arg&pipe|redirect<in>out^caret(100%)!bang"quote`,
    ],
  };
  const logPath = path.join(tmp, "native-probe.log");
  const task = renderTaskXml({
    ...spec,
    execPath: process.execPath,
    args: [probe, ...expected.args],
    workingDirectory: tmp,
    logPath,
    env: { CLC_TASK_PROBE: expected.env },
  }, process.env, nativeLauncherHome);
  const { command, args } = taskAction(task);
  assert(command === windowsLauncherExecutablePath(nativeLauncherHome), `unsafe launcher selected: ${command}`);
  const result = await runExecutable(command, [args], { cwd: tmp, timeoutMs: 30_000 });
  assert(result.exitCode === 0, `exit ${result.exitCode}: ${result.stderr}`);
  const logged = await fs.readFile(logPath, "utf-8");
  assert(JSON.stringify(JSON.parse(logged)) === JSON.stringify(expected), `log: ${logged}`);
});

await checkAsync("the native Windows launcher reports a missing executable as failure", async () => {
  if (process.platform !== "win32") return;
  await compileNativeLauncherFixture();
  const missing = path.join(tmp, "missing", "definitely-not-an-executable.exe");
  const task = renderTaskXml({ ...spec, execPath: missing, args: [], env: {} }, process.env, nativeLauncherHome);
  const { command, args } = taskAction(task);
  const result = await runExecutable(command, [args], { cwd: tmp, timeoutMs: 30_000 });
  assert(result.exitCode !== 0, `missing executable reported exit ${result.exitCode}: ${result.stdout}`);
});

check("the encoded Windows launcher refuses relative and batch executables", () => {
  for (const execPath of [
    "node.exe",
    String.raw`C:\tools\launch.cmd`,
    String.raw`C:\tools\launch.bat`,
    String.raw`C:\tools\launch.cmd. .`,
    String.raw`C:\tools\launch.cmd::$DATA`,
  ]) {
    let message = "";
    try { renderTaskXml({ ...spec, execPath }); } catch (error) { message = error.message; }
    assert(/absolute native executable/i.test(message), `${execPath}: ${message}`);
  }
});

check("the Windows plan says plainly that it is not a service", () => {
  const plan = servicePlan(spec, "win32", home);
  assert(
    plan.notes.some((n) => /not a Windows Service/i.test(n)),
    `the notes should not imply a real service: ${JSON.stringify(plan.notes)}`
  );
  assert(plan.notes.some((n) => /elevation/i.test(n)), "the reason should be stated");

  const [command, args] = plan.installCommands[0];
  assert(path.win32.isAbsolute(command) && command.toLowerCase().endsWith("\\system32\\schtasks.exe"), `unexpected command: ${command}`);
  assert(args.includes("/XML") && args[args.indexOf("/XML") + 1] === plan.unitPath, "the XML path must match");
  assert(!args.includes("/F"), "the static plan must not overwrite an unverified task");
});

check("native Windows system tools ignore environment-controlled Windows roots", () => {
  if (process.platform !== "win32") return;
  const fakeRoot = path.join(tmp, "attacker-controlled-windows");
  const [command] = windowsTaskQueryCommand({ SystemRoot: fakeRoot, windir: fakeRoot });
  assert(!command.toLowerCase().startsWith(fakeRoot.toLowerCase()), `environment selected ${command}`);
  assert(command.toLowerCase().endsWith("\\system32\\schtasks.exe"), `unexpected command: ${command}`);
});

// -------------------------------------------------------------- all three

check("every platform yields absolute paths and a distinct mechanism", () => {
  const mechanisms = new Set();
  for (const platform of ["linux", "darwin", "win32"]) {
    const plan = servicePlan(spec, platform, home);
    mechanisms.add(plan.mechanism);
    assert(path.isAbsolute(plan.unitPath), `${platform}: unit path is not absolute`);
    assert(plan.content.length > 200, `${platform}: content looks empty`);
    if (platform === "win32") {
      const payload = nativeTaskPayload(plan.content);
      assert(payload.execPath === NODE, `${platform}: the executable is missing from the payload`);
      assert(payload.argumentLine.includes("main.js"), `${platform}: the entry point is missing from the payload`);
    } else {
      assert(plan.content.includes(NODE), `${platform}: the executable is missing from the unit`);
      assert(plan.content.includes(ENTRY), `${platform}: the entry point is missing from the unit`);
    }
    assert(plan.installCommands.length >= 1, `${platform}: no install command`);
    assert(plan.uninstallCommands.length >= 1, `${platform}: no uninstall command`);
    assert(plan.stopCommands.length >= 1, `${platform}: no stop command`);
  }
  assert(mechanisms.size === 3, `each platform needs its own mechanism: ${[...mechanisms].join(", ")}`);
});

check("no plan mentions the tunnel: that lifecycle belongs to tunnel-client", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const plan = servicePlan(spec, platform, home);
    const launchContent = platform === "win32" ? nativeTaskPayload(plan.content).argumentLine : plan.content;
    assert(launchContent.includes("--no-tunnel"), `${platform}: the unit should start the server without a tunnel`);
    const commands = [...plan.installCommands, ...plan.uninstallCommands, ...plan.stopCommands]
      .map(([c, a]) => `${c} ${a.join(" ")}`)
      .join("\n");
    assert(!/tunnel-client/.test(commands), `${platform}: a service must not drive tunnel-client`);
  }
});

await checkAsync("generating a plan writes nothing to disk", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const plan = servicePlan(spec, platform, home);
    let exists = true;
    try {
      await fs.access(plan.unitPath);
    } catch {
      exists = false;
    }
    assert(!exists, `${platform}: ${plan.unitPath} was created by generation alone`);
  }
  let homeExists = true;
  try {
    await fs.access(home);
  } catch {
    homeExists = false;
  }
  assert(!homeExists, "the fake home directory should never have been created");
});

await checkAsync("a failed service install restores existing metadata", async () => {
  const fakeHome = path.join(tmp, "failed-install-home");
  const unit = taskXmlPath(fakeHome);
  const installSpec = { ...spec, logPath: path.join(tmp, "failed-install.log") };
  const predecessor = renderWindowsPowerShellPredecessorTaskXml(
    installSpec,
    "installed-window-hidden",
    process.env,
    fakeHome
  );
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "previous task metadata", "utf-8");
  let queries = 0;
  let creates = 0;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      queries++;
      return commandRun({ stdout: predecessor });
    }
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    creates++;
    return commandRun({ exitCode: 1, stderr: "create failed" });
  };
  const result = await installService(
    installSpec,
    "win32",
    { home: fakeHome, runner }
  );
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "the create command should fail");
  assert(queries === 3 && creates === 1, `transaction did not reach create reconciliation: ${queries} queries, ${creates} creates`);
  assert(result.metadataPresent === true, "restored metadata should be reported present");
  assert((await fs.readFile(unit, "utf-8")) === "previous task metadata", "failed install replaced recoverable metadata");
});

await checkAsync("an ambiguous failed first install retains files a committed task may reference", async () => {
  const fakeHome = path.join(tmp, "failed-first-install-home");
  const unit = taskXmlPath(fakeHome);
  let creates = 0;
  const runner = async (command, args) => {
    if (args.includes("/Query")) return commandRun({ exitCode: 1, stderr: "task query unavailable" });
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    creates++;
    return commandRun({ exitCode: 1, stderr: "transport failed after an indeterminate create" });
  };
  const result = await installService(
    { ...spec, logPath: path.join(tmp, "failed-first-install.log") },
    "win32",
    { home: fakeHome, runner }
  );
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "the create command should fail");
  assert(creates === 1, `install failed before task create: ${creates} creates`);
  assert(result.metadataPresent === true, "indeterminate first-install metadata was removed");
  await fs.access(unit);
  await fs.access(taskAction(result.plan.content).command);
});

await checkAsync("a create transport error is reconciled when the intended task committed", async () => {
  const fakeHome = path.join(tmp, "committed-create-error-home");
  let created = false;
  let queries = 0;
  let creates = 0;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      queries++;
      return created
        ? commandRun({ stdout: await readStagedTaskXml(fakeHome) })
        : commandRun({ exitCode: 1, stderr: "task not found" });
    }
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    creates++;
    created = true;
    return commandRun({ exitCode: 1, stderr: "transport failed after Scheduler commit" });
  };

  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(queries === 3 && creates === 1, `unexpected reconciliation calls: ${queries} queries, ${creates} creates`);
  assert(result.commandResults.every((entry) => entry.exitCode === 0), `committed task was reported failed: ${JSON.stringify(result.commandResults)}`);
  assert(result.commandResults.at(-1)?.stderr.includes("confirmed by a post-create ownership query"), "reconciliation was not reported");
  assert(result.metadataPresent, "reconciled task metadata was removed");
  await fs.access(taskAction(result.plan.content).command);
});

await checkAsync("a Windows install rejects launcher support through a parent junction", async () => {
  if (process.platform !== "win32") return;
  const fakeHome = path.join(tmp, "junction-support-home");
  const redirectedSupport = path.join(tmp, "junction-support-target");
  const serviceDirectory = path.dirname(windowsLauncherSourcePath(fakeHome));
  await fs.mkdir(path.dirname(serviceDirectory), { recursive: true });
  await fs.mkdir(redirectedSupport, { recursive: true });
  await fs.symlink(redirectedSupport, serviceDirectory, "junction");
  let calls = 0;
  const runner = async (_command, args) => {
    calls++;
    return args.includes("/Query")
      ? commandRun({ exitCode: 1, stderr: "task not found" })
      : commandRun();
  };

  const result = await installService(spec, "win32", { home: fakeHome, runner });

  assert(calls === 1, `unsafe support path reached ${calls - 1} command(s) after the ownership query`);
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "junction-backed support path reported success");
  assert((await fs.readdir(redirectedSupport)).length === 0, "install wrote launcher support through the junction");
  await fs.access(taskXmlPath(fakeHome)).then(
    () => { throw new Error("blocked junction install left task XML behind"); },
    () => undefined
  );
});

await checkAsync("a Windows install compiles fresh bytes instead of adopting a planted GUI executable", async () => {
  if (process.platform !== "win32") return;
  const compiledFixture = await compileNativeLauncherFixture();
  const fakeHome = path.join(tmp, "planted-launcher-home");
  const planted = windowsLauncherExecutablePath(fakeHome);
  await fs.mkdir(path.dirname(planted), { recursive: true });
  await fs.writeFile(windowsLauncherSourcePath(fakeHome), WINDOWS_LAUNCHER_SOURCE, "utf8");
  await fs.copyFile(compiledFixture, planted);
  let compileCalls = 0;
  let createCalls = 0;
  let created = false;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      return created
        ? commandRun({ stdout: await readStagedTaskXml(fakeHome) })
        : commandRun({ exitCode: 1, stderr: "task not found" });
    }
    if (/powershell\.exe$/i.test(command)) {
      compileCalls++;
      const { outputPath } = launcherCompilePaths(args);
      await fs.copyFile(compiledFixture, outputPath);
      return commandRun();
    }
    createCalls++;
    created = true;
    return commandRun();
  };

  const result = await installService(spec, "win32", { home: fakeHome, runner });
  const installedCommand = taskAction(result.plan.content).command;
  const installedDigest = path.win32.basename(installedCommand).match(/^ChatGPTLocalCoderLauncher-([a-f0-9]{64})\.exe$/i)?.[1];
  assert(result.commandResults.every((entry) => entry.exitCode === 0), `install failed: ${JSON.stringify(result.commandResults)}`);
  assert(compileCalls === 1, `installer compiled ${compileCalls} fresh launchers`);
  assert(createCalls === 1, `installer created ${createCalls} tasks`);
  assert(installedCommand !== planted, "installer adopted the planted predictable executable");
  assert(installedDigest, `installed launcher is not binary-content-addressed: ${installedCommand}`);
  const installedBytes = await fs.readFile(installedCommand);
  assert(createHash("sha256").update(installedBytes).digest("hex") === installedDigest, "launcher filename digest does not match its bytes");
});

await checkAsync("a registered native task is owned only while its launcher bytes match the filename digest", async () => {
  if (process.platform !== "win32") return;
  const compiledFixture = await compileNativeLauncherFixture();
  const bytes = await fs.readFile(compiledFixture);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fakeHome = path.join(tmp, "native-task-digest-home");
  const executable = windowsLauncherExecutablePath(fakeHome, digest);
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, bytes);
  const task = renderTaskXml(spec, process.env, fakeHome, executable);

  let ended = false;
  const valid = await stopService(spec, "win32", {
    home: fakeHome,
    runner: async (_command, args) => {
      if (args.includes("/Query")) return commandRun({ stdout: task });
      ended = args.includes("/End");
      return commandRun();
    },
  });
  assert(ended && valid.commandResults.every((entry) => entry.exitCode === 0), "valid published launcher was not owned");

  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  await fs.writeFile(executable, tampered);
  let calls = 0;
  const blocked = await stopService(spec, "win32", {
    home: fakeHome,
    runner: async () => {
      calls++;
      return commandRun({ stdout: task });
    },
  });
  assert(calls === 1, "tampered launcher reached the stop mutation");
  assert(blocked.commandResults[0]?.exitCode !== 0, "tampered launcher was still treated as owned");
});

await checkAsync("a successful owned uninstall retains launcher support when absence cannot be proved", async () => {
  if (process.platform !== "win32") return;
  const compiledFixture = await compileNativeLauncherFixture();
  const bytes = await fs.readFile(compiledFixture);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fakeHome = path.join(tmp, "native-uninstall-cleanup-home");
  const executable = windowsLauncherExecutablePath(fakeHome, digest);
  const invalid = windowsLauncherExecutablePath(fakeHome, "f".repeat(64));
  const source = windowsLauncherSourcePath(fakeHome);
  const unit = taskXmlPath(fakeHome);
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, bytes);
  await fs.writeFile(invalid, bytes);
  await fs.writeFile(source, WINDOWS_LAUNCHER_SOURCE, "utf8");
  await fs.writeFile(unit, "owned task metadata", "utf8");
  const task = renderTaskXml(spec, process.env, fakeHome, executable);
  let deleted = false;
  let queries = 0;
  const result = await uninstallService(spec, "win32", {
    home: fakeHome,
    runner: async (_command, args) => {
      if (args.includes("/Query")) {
        queries++;
        return commandRun({ stdout: task });
      }
      if (args.includes("/Delete")) deleted = true;
      return commandRun();
    },
  });
  assert(deleted && result.commandResults.every((entry) => entry.exitCode === 0), "owned uninstall failed");
  assert(queries === 1, `uninstall trusted an ambiguous post-delete query: ${queries} queries`);
  assert(result.metadataPresent === false, "successful uninstall kept retry metadata");
  assert((await fs.readFile(executable)).equals(bytes), "potentially referenced launcher was deleted");
  assert((await fs.readFile(source, "utf8")) === WINDOWS_LAUNCHER_SOURCE, "launcher source was deleted");
  assert((await fs.readFile(invalid)).equals(bytes), "digest-mismatched file was deleted");
});

await checkAsync("a binary-hash publication collision fails closed without overwriting the planted file", async () => {
  if (process.platform !== "win32") return;
  const compiledFixture = await compileNativeLauncherFixture();
  const freshBytes = await fs.readFile(compiledFixture);
  const digest = createHash("sha256").update(freshBytes).digest("hex");
  const fakeHome = path.join(tmp, "launcher-hash-collision-home");
  const collisionPath = windowsLauncherExecutablePath(fakeHome, digest);
  const plantedBytes = Buffer.from(freshBytes);
  plantedBytes[plantedBytes.length - 1] ^= 1;
  await fs.mkdir(path.dirname(collisionPath), { recursive: true });
  await fs.writeFile(collisionPath, plantedBytes);
  let createCalls = 0;
  const result = await installService(spec, "win32", {
    home: fakeHome,
    runner: async (command, args) => {
      if (args.includes("/Query")) return commandRun({ exitCode: 1, stderr: "task not found" });
      if (/powershell\.exe$/i.test(command)) {
        await emulateSuccessfulLauncherCompile(args);
        return commandRun();
      }
      createCalls++;
      return commandRun();
    },
  });
  assert(createCalls === 0, "task creation ran after a launcher hash collision");
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "launcher hash collision reported success");
  assert((await fs.readFile(collisionPath)).equals(plantedBytes), "collision file was overwritten or removed");
});

await checkAsync("a failed launcher compilation never rewrites an existing content-addressed executable", async () => {
  if (process.platform !== "win32") return;
  const compiledFixture = await compileNativeLauncherFixture();
  const fakeHome = path.join(tmp, "existing-launcher-rollback-home");
  const unit = taskXmlPath(fakeHome);
  const source = windowsLauncherSourcePath(fakeHome);
  const executable = windowsLauncherExecutablePath(fakeHome);
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(unit, "previous task metadata", "utf-8");
  await fs.writeFile(source, WINDOWS_LAUNCHER_SOURCE, "utf-8");
  await fs.copyFile(compiledFixture, executable);
  const executableBefore = await fs.readFile(executable);
  const runner = async (_command, args) =>
    args.includes("/Query")
      ? commandRun({ exitCode: 1, stderr: "task not found" })
      : commandRun({ exitCode: 1, stderr: "create failed" });
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "failed compilation reported success");
  assert((await fs.readFile(unit, "utf-8")) === "previous task metadata", "task XML was not restored");
  assert((await fs.readFile(source, "utf-8")) === WINDOWS_LAUNCHER_SOURCE, "existing source was rewritten");
  assert((await fs.readFile(executable)).equals(executableBefore), "existing executable was rewritten during rollback");
});

await checkAsync("a failed service uninstall preserves metadata for retry", async () => {
  const fakeHome = path.join(tmp, "failed-uninstall-home");
  const unit = taskXmlPath(fakeHome);
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "task metadata for retry", "utf-8");
  const runner = async (_command, args) =>
    args.includes("/Query")
      ? commandRun({ stdout: renderTaskXml(spec) })
      : commandRun({ exitCode: 1, stderr: "delete failed" });
  const result = await uninstallService(
    { ...spec, logPath: path.join(tmp, "failed-uninstall.log") },
    "win32",
    { home: fakeHome, runner }
  );
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "the delete command should fail");
  assert(result.metadataPresent === true, "retry metadata should be reported present");
  assert((await fs.readFile(unit, "utf-8")) === "task metadata for retry", "failed uninstall removed retry metadata");
});

await checkAsync("a colliding unowned Windows task is never overwritten, stopped, or deleted", async () => {
  for (const operation of ["install", "stop", "uninstall"]) {
    const fakeHome = path.join(tmp, `collision-${operation}-home`);
    const unit = taskXmlPath(fakeHome);
    await fs.mkdir(path.dirname(unit), { recursive: true });
    await fs.writeFile(unit, "our previous metadata", "utf-8");
    let calls = 0;
    const runner = async () => {
      calls++;
      return commandRun({ stdout: "<Task><Description>someone else's task</Description></Task>" });
    };
    const result = operation === "install"
      ? await installService(spec, "win32", { home: fakeHome, runner })
      : operation === "stop"
        ? await stopService(spec, "win32", { home: fakeHome, runner })
        : await uninstallService(spec, "win32", { home: fakeHome, runner });
    assert(calls === 1, `${operation} ran a mutating command after the ownership probe`);
    assert(result.commandResults[0]?.exitCode !== 0, `${operation} accepted an unowned collision`);
    assert(result.metadataPresent === true, `${operation} lost local recovery metadata`);
    assert((await fs.readFile(unit, "utf-8")) === "our previous metadata", `${operation} changed metadata`);
  }
});

await checkAsync("a verified owned Windows task may be replaced and uninstalled", async () => {
  const fakeHome = path.join(tmp, "owned-task-home");
  const unit = taskXmlPath(fakeHome);
  const ownedDefinition = renderWindowsPowerShellPredecessorTaskXml(spec, "installed-window-hidden", process.env, fakeHome);
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "old owned metadata", "utf-8");
  let createArgs;
  let installedTask = false;
  const installRunner = async (command, args) => {
    if (args.includes("/Query")) {
      return commandRun({ stdout: installedTask ? await readStagedTaskXml(fakeHome) : ownedDefinition });
    }
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    createArgs = args;
    installedTask = true;
    return commandRun();
  };
  const installed = await installService(spec, "win32", { home: fakeHome, runner: installRunner });
  assert(installed.commandResults.every((entry) => entry.exitCode === 0), "owned task update failed");
  assert(createArgs?.includes("/F"), "verified owned task update did not enable replacement");
  assert(installed.metadataPresent === true, "installed metadata should be present");

  let ended = false;
  const stopRunner = async (_command, args) => {
    if (args.includes("/Query")) return commandRun({ stdout: ownedDefinition });
    ended = args.includes("/End");
    return commandRun();
  };
  const stopped = await stopService(spec, "win32", { home: fakeHome, runner: stopRunner });
  assert(ended && stopped.commandResults.every((entry) => entry.exitCode === 0), "verified owned task was not stopped");

  let deleted = false;
  const uninstallRunner = async (_command, args) => {
    if (args.includes("/Query")) {
      return deleted ? commandRun({ exitCode: 1, stderr: "task not found" }) : commandRun({ stdout: ownedDefinition });
    }
    if (args.includes("/Delete")) deleted = true;
    return commandRun();
  };
  const uninstalled = await uninstallService(spec, "win32", { home: fakeHome, runner: uninstallRunner });
  assert(deleted, "verified owned task was not deleted");
  assert(uninstalled.metadataPresent === false, "successful uninstall left metadata behind");
});

await checkAsync("the exact installed PowerShell WindowStyle predecessor upgrades with a second ownership check", async () => {
  const fakeHome = path.join(tmp, "installed-predecessor-home");
  const predecessor = renderWindowsPowerShellPredecessorTaskXml(spec, "installed-window-hidden", process.env, fakeHome);
  let queries = 0;
  let createArgs;
  let installedTask = false;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      queries++;
      return commandRun({ stdout: installedTask ? await readStagedTaskXml(fakeHome) : predecessor });
    }
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    createArgs = args;
    installedTask = true;
    return commandRun();
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(result.commandResults.every((entry) => entry.exitCode === 0), `migration failed: ${JSON.stringify(result.commandResults)}`);
  assert(queries === 3, `predecessor ownership was queried ${queries} times`);
  assert(createArgs?.includes("/F"), "exact installed predecessor did not enable replacement");
});

await checkAsync("a first Windows install cannot overwrite a task when the ownership query misses", async () => {
  const fakeHome = path.join(tmp, "clean-install-home");
  let createArgs;
  let installedTask = false;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      return installedTask
        ? commandRun({ stdout: await readStagedTaskXml(fakeHome) })
        : commandRun({ exitCode: 1, stderr: "task not found" });
    }
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    createArgs = args;
    installedTask = true;
    return commandRun();
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(result.commandResults.every((entry) => entry.exitCode === 0), "clean install failed");
  assert(!createArgs?.includes("/F"), "unverified install enabled overwrite");
});

await checkAsync("Windows install compiles support before an immediate ownership re-query and task create", async () => {
  const fakeHome = path.join(tmp, "ordered-native-install-home");
  const events = [];
  let installedTask = false;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      events.push("query");
      return installedTask
        ? commandRun({ stdout: await readStagedTaskXml(fakeHome) })
        : commandRun({ exitCode: 1, stderr: "task not found" });
    }
    if (/powershell\.exe$/i.test(command)) {
      events.push("compile");
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    events.push("create");
    installedTask = true;
    return commandRun();
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(result.commandResults.every((entry) => entry.exitCode === 0), `install failed: ${JSON.stringify(result.commandResults)}`);
  assert(JSON.stringify(events) === JSON.stringify(["query", "compile", "query", "create", "query"]), `order: ${events.join(" -> ")}`);
  assert((await fs.readFile(windowsLauncherSourcePath(fakeHome), "utf-8")) === WINDOWS_LAUNCHER_SOURCE, "launcher source was not staged exactly");
});

await checkAsync("a task appearing during launcher compilation blocks create and rolls support files back", async () => {
  const fakeHome = path.join(tmp, "second-query-collision-home");
  let queries = 0;
  let creates = 0;
  const runner = async (command, args) => {
    if (args.includes("/Query")) {
      queries++;
      return queries === 1
        ? commandRun({ exitCode: 1, stderr: "task not found" })
        : commandRun({ stdout: "<Task><Description>concurrent unowned task</Description></Task>" });
    }
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    creates++;
    return commandRun();
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(queries === 2, `ownership was queried ${queries} times`);
  assert(creates === 0, "task create ran after the second query found a collision");
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "concurrent collision reported success");
  await fs.access(taskXmlPath(fakeHome)).then(
    () => { throw new Error("blocked install left task XML behind"); },
    () => undefined
  );
  await fs.access(windowsLauncherSourcePath(fakeHome)).then(
    () => { throw new Error("blocked install left launcher source behind"); },
    () => undefined
  );
});

await checkAsync("an owned task changing to another owned definition during compilation blocks create", async () => {
  const fakeHome = path.join(tmp, "second-query-owned-race-home");
  const before = renderWindowsPowerShellPredecessorTaskXml(spec, "schema-v1", process.env, fakeHome);
  const after = renderWindowsPowerShellPredecessorTaskXml(spec, "installed-window-hidden", process.env, fakeHome)
    .replace("    <Hidden>false</Hidden>\n", "");
  let queries = 0;
  let creates = 0;
  const runner = async (command, args) => {
    if (args.includes("/Query")) return commandRun({ stdout: ++queries === 1 ? before : after });
    if (/powershell\.exe$/i.test(command)) {
      await emulateSuccessfulLauncherCompile(args);
      return commandRun();
    }
    creates++;
    return commandRun();
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(queries === 2, `ownership was queried ${queries} times`);
  assert(creates === 0, "task create ran after an owned-to-owned race");
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "owned-to-owned race reported success");
});

await checkAsync("a truncated Windows ownership query blocks with a non-zero result", async () => {
  const fakeHome = path.join(tmp, "truncated-query-home");
  let calls = 0;
  const runner = async () => {
    calls++;
    return commandRun({ stdout: renderTaskXml(spec), truncated: true });
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(calls === 1, `ran ${calls} commands after a truncated query`);
  assert(result.commandResults[0]?.exitCode !== 0, "truncated ownership output reported success");
  assert(result.metadataPresent === false, "blocked operation wrote metadata");
});

await checkAsync("service command sequences stop after their first failure", async () => {
  const fakeHome = path.join(tmp, "stop-after-failure-home");
  let calls = 0;
  const runner = async () => {
    calls++;
    return commandRun({ exitCode: 1, stderr: "first command failed" });
  };
  const result = await installService(spec, "linux", { home: fakeHome, runner });
  assert(calls === 1, `ran ${calls} commands after the first failure`);
  assert(result.commandResults.length === 1, `recorded ${result.commandResults.length} commands`);
});

await checkAsync("multi-step install failures keep the definition the manager may have loaded", async () => {
  for (const platform of ["linux", "darwin"]) {
    const fakeHome = path.join(tmp, `${platform}-second-command-home`);
    const unit = platform === "linux" ? systemdUnitPath(fakeHome) : launchdPlistPath(fakeHome);
    await fs.mkdir(path.dirname(unit), { recursive: true });
    await fs.writeFile(unit, "previous definition", "utf-8");
    let calls = 0;
    const runner = async () => {
      calls++;
      return calls === 1 ? commandRun() : commandRun({ exitCode: 1, stderr: "second command failed" });
    };
    const result = await installService(spec, platform, { home: fakeHome, runner });
    assert(calls === 2, `${platform}: expected two calls, got ${calls}`);
    assert(result.commandResults[1]?.exitCode !== 0, `${platform}: second failure missing`);
    assert(result.metadataPresent === true, `${platform}: retry definition is absent`);
    const current = await fs.readFile(unit, "utf-8");
    assert(current !== "previous definition", `${platform}: restored metadata that may no longer match manager state`);
    assert(current === result.plan.content, `${platform}: retry metadata differs from the attempted definition`);
  }
});

// ------------------------------------------------------------ log rotation
// The supervisor opens the log itself and hands the descriptor to the server,
// so rotation has to copy-and-truncate. Renaming would leave the descriptor on
// the rotated inode and every later line would vanish from the live file.
await checkAsync("rotateServerLog leaves a small log alone", async () => {
  const small = path.join(tmp, "small.log");
  await fs.writeFile(small, "one line\n");
  assert((await rotateServerLog(small)) === false, "a small log should not roll over");
  assert((await fs.readFile(small, "utf-8")) === "one line\n", "contents were altered");
  let rotatedExists = true;
  try { await fs.access(`${small}.1`); } catch { rotatedExists = false; }
  assert(!rotatedExists, "no .1 should be produced below the threshold");
});

await checkAsync("rotateServerLog rolls a large log over and keeps the inode", async () => {
  const big = path.join(tmp, "big.log");
  const payload = "x".repeat(9 * 1024 * 1024);
  await fs.writeFile(big, payload);
  const inodeBefore = (await fs.stat(big)).ino;

  const handle = await fs.open(big, "a");
  try {
    assert((await rotateServerLog(big)) === true, "a log past the cap should roll over");
    assert((await fs.stat(big)).size === 0, "the live log should be empty after rotation");
    assert((await fs.stat(big)).ino === inodeBefore, "the descriptor's inode must survive");
    assert((await fs.readFile(`${big}.1`, "utf-8")).length === payload.length, "history was not preserved");

    // The held descriptor must still land in the file everyone is reading.
    await handle.write("after rotation\n");
    assert((await fs.readFile(big, "utf-8")) === "after rotation\n", "writes went somewhere else");
  } finally {
    await handle.close();
  }
});

await checkAsync("rotateServerLog is a no-op when there is no log yet", async () => {
  assert((await rotateServerLog(path.join(tmp, "absent.log"))) === false, "a missing log is not an error");
});

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
