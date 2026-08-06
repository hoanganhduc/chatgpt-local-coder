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
  launchdPlistPath,
  renderLaunchAgent,
  renderSystemdUnit,
  renderTaskXml,
  servicePlan,
  systemdUnitPath,
  TASK_NAME,
  taskXmlPath,
  UNIT_NAME,
  rotateServerLog,
} from "../dist/services/index.js";

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
  includes(unit, `ExecStart=${NODE} ${ENTRY} up --no-tunnel`, "ExecStart");
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

check("the task XML runs the absolute exec path with the environment prefix", () => {
  const task = renderTaskXml(spec);
  includes(task, '<?xml version="1.0" encoding="UTF-16"?>', "schtasks requires the UTF-16 declaration");
  includes(task, "<Command>cmd.exe</Command>", "the command is the shell wrapper");
  includes(task, `<WorkingDirectory>${WORKDIR}</WorkingDirectory>`, "working directory");
  includes(task, "<LogonTrigger>", "logon trigger");
  includes(task, "<RunLevel>LeastPrivilege</RunLevel>", "no elevation");

  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(task)?.[1];
  assert(args?.startsWith("/c set CLC_CONFIG_DIR="), `arguments start: ${args?.slice(0, 40)}`);
  includes(args, "set NODE_ENV=production", "second variable");
  includes(args, `&quot;${NODE}&quot;`, "the exec path is quoted");
  includes(args, "up --no-tunnel", "the remaining argv");
});

check("the task XML escapes the && separator exactly once", () => {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(renderTaskXml(spec))?.[1] ?? "";
  includes(args, "&amp;&amp;", "the separator must be a single XML escape");
  assert(!args.includes("&amp;amp;"), `double-escaped: ${args}`);
  assert(!/&&/.test(args.replace(/&amp;/g, "")), "no raw ampersand may survive");
});

check("the Windows plan says plainly that it is not a service", () => {
  const plan = servicePlan(spec, "win32", home);
  assert(
    plan.notes.some((n) => /not a Windows Service/i.test(n)),
    `the notes should not imply a real service: ${JSON.stringify(plan.notes)}`
  );
  assert(plan.notes.some((n) => /elevation/i.test(n)), "the reason should be stated");

  const [command, args] = plan.installCommands[0];
  assert(command === "schtasks", `unexpected command: ${command}`);
  assert(args.includes("/XML") && args[args.indexOf("/XML") + 1] === plan.unitPath, "the XML path must match");
  assert(args.includes("/F"), "install should overwrite an existing task");
});

// -------------------------------------------------------------- all three

check("every platform yields absolute paths and a distinct mechanism", () => {
  const mechanisms = new Set();
  for (const platform of ["linux", "darwin", "win32"]) {
    const plan = servicePlan(spec, platform, home);
    mechanisms.add(plan.mechanism);
    assert(path.isAbsolute(plan.unitPath), `${platform}: unit path is not absolute`);
    assert(plan.content.length > 200, `${platform}: content looks empty`);
    assert(plan.content.includes(NODE), `${platform}: the executable is missing from the unit`);
    assert(plan.content.includes(ENTRY), `${platform}: the entry point is missing from the unit`);
    assert(plan.installCommands.length >= 1, `${platform}: no install command`);
    assert(plan.uninstallCommands.length >= 1, `${platform}: no uninstall command`);
    assert(plan.stopCommands.length >= 1, `${platform}: no stop command`);
  }
  assert(mechanisms.size === 3, `each platform needs its own mechanism: ${[...mechanisms].join(", ")}`);
});

check("no plan mentions the tunnel: that lifecycle belongs to tunnel-client", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const plan = servicePlan(spec, platform, home);
    assert(plan.content.includes("--no-tunnel"), `${platform}: the unit should start the server without a tunnel`);
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
