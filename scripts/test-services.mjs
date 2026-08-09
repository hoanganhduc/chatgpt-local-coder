/**
 * Service generators (T11): the systemd user unit, the LaunchAgent and the
 * schtasks logon task are asserted as strings for all three platforms from
 * whichever platform is running this file.
 *
 * Nothing here installs anything. `servicePlan` takes the platform and the home
 * directory as parameters precisely so the generated content can be checked
 * without touching the machine's real service manager.
 */
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
  servicePlan,
  stopService,
  systemdUnitPath,
  TASK_NAME,
  TASK_OWNERSHIP_MARKER,
  taskXmlPath,
  UNIT_NAME,
  uninstallService,
  rotateServerLog,
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

check("the task XML uses an absolute encoded PowerShell launcher", () => {
  const task = renderTaskXml(spec);
  includes(task, '<?xml version="1.0" encoding="UTF-16"?>', "schtasks requires the UTF-16 declaration");
  includes(task, `<WorkingDirectory>${WORKDIR}</WorkingDirectory>`, "working directory");
  includes(task, "<LogonTrigger>", "logon trigger");
  includes(task, "<RunLevel>LeastPrivilege</RunLevel>", "no elevation");
  includes(task, TASK_OWNERSHIP_MARKER, "stable task ownership marker");

  const { command, args } = taskAction(task);
  assert(path.win32.isAbsolute(command), `PowerShell path is not absolute: ${command}`);
  assert(command.toLowerCase().endsWith("\\windowspowershell\\v1.0\\powershell.exe"), `command: ${command}`);
  assert(/^-NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/.test(args), `arguments: ${args}`);
  const payload = taskPayload(task);
  assert(payload.execPath === NODE, `exec path: ${payload.execPath}`);
  assert(typeof payload.argumentLine === "string" && payload.argumentLine.includes("--no-tunnel"), `arguments: ${payload.argumentLine}`);
  assert(payload.workingDirectory === WORKDIR, `working directory: ${payload.workingDirectory}`);
  assert(JSON.stringify(payload.env) === JSON.stringify(spec.env), `environment: ${JSON.stringify(payload.env)}`);
});

check("the task keeps environment values and argv out of the PowerShell command text", () => {
  const hostile = {
    ...spec,
    args: [String.raw`C:\safe&pipe|redirect<in>out^caret(100%)!bang"quote\main.js`, "up"],
    env: { CLC_CONFIG_DIR: String.raw`C:\config&pipe|redirect<in>out^caret(100%)!bang"quote`, NODE_ENV: "production" },
  };
  const task = renderTaskXml(hostile);
  const { args } = taskAction(task);
  const script = decodedTaskScript(task);
  for (const value of [hostile.execPath, ...hostile.args, ...Object.values(hostile.env)]) {
    assert(!args.includes(value), `raw value reached task arguments: ${JSON.stringify(value)}`);
    assert(!script.includes(value), `raw value reached PowerShell script: ${JSON.stringify(value)}`);
  }
  const payload = taskPayload(task);
  assert(payload.execPath === hostile.execPath, `exec path: ${payload.execPath}`);
  assert(payload.workingDirectory === hostile.workingDirectory, `working directory: ${payload.workingDirectory}`);
  assert(JSON.stringify(payload.env) === JSON.stringify(hostile.env), `environment: ${JSON.stringify(payload.env)}`);
});

check("Windows task ownership requires an exact structured action", () => {
  const owned = renderTaskXml(spec);
  assert(isOwnedWindowsTask(owned, spec), "current marker-bearing task was not recognized");
  const forgedAction = owned.replace(/<Command>[\s\S]*?<\/Command>/, "<Command>C:\\attacker\\payload.exe</Command>");
  assert(!isOwnedWindowsTask(forgedAction, spec), "marker alone accepted a forged action");
  const scattered = `<Task><Description>other</Description><Command>other.exe</Command><Arguments>${TASK_OWNERSHIP_MARKER} ${xmlEncode(NODE)} --no-tunnel</Arguments><WorkingDirectory>${xmlEncode(WORKDIR)}</WorkingDirectory></Task>`;
  assert(!isOwnedWindowsTask(scattered, spec), "scattered ownership substrings were accepted");

  const legacyEnv = Object.entries(spec.env).map(([key, value]) => `set ${key}=${value}&& `).join("");
  const legacyArgs = spec.args.map((part) => part.includes(" ") ? `"${part}"` : part).join(" ");
  const legacy = `<Task><RegistrationInfo><Description>${xmlEncode(spec.description)}</Description></RegistrationInfo><Actions><Exec><Command>cmd.exe</Command><Arguments>${xmlEncode(`/c ${legacyEnv}"${spec.execPath}" ${legacyArgs}`)}</Arguments><WorkingDirectory>${xmlEncode(spec.workingDirectory)}</WorkingDirectory></Exec></Actions></Task>`;
  assert(isOwnedWindowsTask(legacy, spec), "exact legacy task was not recognized for migration");
});

await checkAsync("the encoded Windows launcher preserves metacharacters without executing them", async () => {
  if (process.platform !== "win32") return;
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
  const task = renderTaskXml({
    ...spec,
    execPath: process.execPath,
    args: [probe, ...expected.args],
    workingDirectory: tmp,
    env: { CLC_TASK_PROBE: expected.env },
  });
  const { command, args } = taskAction(task);
  assert(/powershell\.exe$/i.test(command), `unsafe launcher selected: ${command}`);
  const result = await runExecutable(command, args.split(/\s+/), { cwd: tmp, timeoutMs: 30_000 });
  assert(result.exitCode === 0, `exit ${result.exitCode}: ${result.stderr}`);
  assert(JSON.stringify(JSON.parse(result.stdout)) === JSON.stringify(expected), `stdout: ${result.stdout}`);
});

await checkAsync("the encoded Windows launcher reports a missing executable as failure", async () => {
  if (process.platform !== "win32") return;
  const missing = path.join(tmp, "missing", "definitely-not-an-executable.exe");
  const task = renderTaskXml({ ...spec, execPath: missing, args: [], env: {} });
  const { command, args } = taskAction(task);
  const result = await runExecutable(command, args.split(/\s+/), { cwd: tmp, timeoutMs: 30_000 });
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
      const payload = taskPayload(plan.content);
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
    const launchContent = platform === "win32" ? taskPayload(plan.content).argumentLine : plan.content;
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
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "previous task metadata", "utf-8");
  const runner = async (_command, args) =>
    args.includes("/Query")
      ? commandRun({ exitCode: 1, stderr: "task not found" })
      : commandRun({ exitCode: 1, stderr: "create failed" });
  const result = await installService(
    { ...spec, logPath: path.join(tmp, "failed-install.log") },
    "win32",
    { home: fakeHome, runner }
  );
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "the create command should fail");
  assert(result.metadataPresent === true, "restored metadata should be reported present");
  assert((await fs.readFile(unit, "utf-8")) === "previous task metadata", "failed install replaced recoverable metadata");
});

await checkAsync("a failed first service install removes newly written metadata", async () => {
  const fakeHome = path.join(tmp, "failed-first-install-home");
  const unit = taskXmlPath(fakeHome);
  const runner = async (_command, args) =>
    args.includes("/Query")
      ? commandRun({ exitCode: 1, stderr: "task not found" })
      : commandRun({ exitCode: 1, stderr: "create failed" });
  const result = await installService(
    { ...spec, logPath: path.join(tmp, "failed-first-install.log") },
    "win32",
    { home: fakeHome, runner }
  );
  assert(result.commandResults.some((entry) => entry.exitCode !== 0), "the create command should fail");
  assert(result.metadataPresent === false, "removed first-install metadata should be reported absent");
  await fs.access(unit).then(
    () => { throw new Error("failed install left new metadata behind"); },
    () => undefined
  );
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
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "old owned metadata", "utf-8");
  let createArgs;
  const installRunner = async (_command, args) => {
    if (args.includes("/Query")) return commandRun({ stdout: renderTaskXml(spec) });
    createArgs = args;
    return commandRun();
  };
  const installed = await installService(spec, "win32", { home: fakeHome, runner: installRunner });
  assert(installed.commandResults.every((entry) => entry.exitCode === 0), "owned task update failed");
  assert(createArgs?.includes("/F"), "verified owned task update did not enable replacement");
  assert(installed.metadataPresent === true, "installed metadata should be present");

  let ended = false;
  const stopRunner = async (_command, args) => {
    if (args.includes("/Query")) return commandRun({ stdout: renderTaskXml(spec) });
    ended = args.includes("/End");
    return commandRun();
  };
  const stopped = await stopService(spec, "win32", { home: fakeHome, runner: stopRunner });
  assert(ended && stopped.commandResults.every((entry) => entry.exitCode === 0), "verified owned task was not stopped");

  let deleted = false;
  const uninstallRunner = async (_command, args) => {
    if (args.includes("/Query")) return commandRun({ stdout: renderTaskXml(spec) });
    deleted = args.includes("/Delete");
    return commandRun();
  };
  const uninstalled = await uninstallService(spec, "win32", { home: fakeHome, runner: uninstallRunner });
  assert(deleted, "verified owned task was not deleted");
  assert(uninstalled.metadataPresent === false, "successful uninstall left metadata behind");
});

await checkAsync("a first Windows install cannot overwrite a task when the ownership query misses", async () => {
  const fakeHome = path.join(tmp, "clean-install-home");
  let createArgs;
  const runner = async (_command, args) => {
    if (args.includes("/Query")) return commandRun({ exitCode: 1, stderr: "task not found" });
    createArgs = args;
    return commandRun();
  };
  const result = await installService(spec, "win32", { home: fakeHome, runner });
  assert(result.commandResults.every((entry) => entry.exitCode === 0), "clean install failed");
  assert(!createArgs?.includes("/F"), "unverified install enabled overwrite");
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
