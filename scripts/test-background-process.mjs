/**
 * `stop_process` has to reach the job, not just the shell that leads it.
 *
 * A background command is a shell that starts a program that starts more; the
 * stop used to signal the one process this host spawned, so `npm run dev` kept
 * its port while the tool reported a stop. The state directory and audit path
 * are set before the import: ESM hoists static imports, so a plain `import`
 * would run before the assignment and write into the repository instead.
 */
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-bg-"));
process.env.MCP_SHELL_STATE_DIR = path.join(tmp, "state");
process.env.AUDIT_LOG_PATH = path.join(tmp, "audit.log");

const { registerShellTools } = await import("../dist/tools/shell.js");
const { setPermissionContext } = await import("../dist/lib/permissions.js");

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e?.message || e}`); failed++; }

setPermissionContext({ profile: "open", roots: [tmp] });

/** A minimal stand-in for McpServer that records what was registered. */
function fakeServer() {
  const tools = new Map();
  const server = { registerTool: (name, config, callback) => tools.set(name, callback) };
  return {
    server,
    call: async (name, args) => (await tools.get(name)(args, { sessionId: "s1" })).structuredContent.data,
  };
}

const app = fakeServer();
registerShellTools(app.server, tmp, 30);

/**
 * A job of the shape the fix is about: a process that starts another and stays
 * alive, so stopping it has to reach one level further down.
 *
 * The leaf is detached on Windows and not on POSIX, for opposite reasons that
 * arrive at the same test. libuv puts a child in a job object killed when its
 * parent exits, so a leaf that stayed in it would die with the fixture on
 * Windows whatever `stop_process` did — proving nothing. On POSIX it stays in
 * the process group, which is precisely the thing being reached.
 */
const holder = path.join(tmp, "holder.mjs");
await fs.writeFile(
  holder,
  [
    'import { spawn } from "child_process";',
    'import fs from "fs";',
    "const [, , pidFile] = process.argv;",
    'const leaf = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {',
    '  stdio: "ignore",',
    '  detached: process.platform === "win32",',
    "});",
    "leaf.unref();",
    "fs.writeFileSync(pidFile, String(leaf.pid));",
    "setTimeout(() => {}, 60000);",
  ].join("\n"),
  "utf-8"
);

/**
 * The same job shape as above, holding the thing a user actually notices: a TCP
 * port. A pid that outlives its stop is the mechanism; a port that stays taken
 * is the complaint, and only one of the two is visible from outside.
 *
 * The server picks port 0 and reports back what it was given, so parallel jobs
 * on one runner cannot collide over a fixed number.
 */
const portServer = path.join(tmp, "port-server.mjs");
await fs.writeFile(
  portServer,
  [
    'import http from "http";',
    'import fs from "fs";',
    "const [, , portFile] = process.argv;",
    'const server = http.createServer((_, res) => res.end("ok"));',
    'server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));',
    "// A listening server stays alive on its own, so it needs a way out of its",
    "// own accord: a stop that failed must not leave a port held until reboot.",
    "setTimeout(() => process.exit(0), 60000);",
  ].join("\n"),
  "utf-8"
);

const portLauncher = path.join(tmp, "port-launcher.mjs");
await fs.writeFile(
  portLauncher,
  [
    'import { spawn } from "child_process";',
    "const [, , portFile] = process.argv;",
    "// Detached on Windows for the reason the fixture above is: a leaf left in",
    "// its parent's job object dies when the parent does, which would let the",
    "// stop appear to work without the tree ever being walked.",
    `spawn(process.execPath, [${JSON.stringify(portServer)}, portFile], {`,
    '  stdio: "ignore",',
    '  detached: process.platform === "win32",',
    "}).unref();",
    "setTimeout(() => {}, 60000);",
  ].join("\n"),
  "utf-8"
);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Whether anything is listening — asked from outside, as a client would. */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

async function poll(check, ms, intervalMs = 100) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

/** Start the fixture and wait until its descendant exists. */
async function startHolder(label) {
  const pidFile = path.join(tmp, `${label}.pid`);
  const started = await app.call("start_process", { command: `node "${holder}" "${pidFile}"` });
  const leaf = await poll(
    async () => Number(await fs.readFile(pidFile, "utf-8").catch(() => "0")) || undefined,
    20000
  );
  if (!leaf) throw new Error("the fixture never recorded a descendant pid");
  if (!isAlive(leaf)) throw new Error(`descendant ${leaf} was never alive`);
  return { id: started.id, leaf };
}

const strays = [];
async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

await run("a forced stop reaches the descendants of the shell it started", async () => {
  const { id, leaf } = await startHolder("force");
  strays.push(leaf);
  const stopped = await app.call("stop_process", { id, force: true });
  if (stopped.already_exited) throw new Error("reported as already gone before it was stopped");
  const gone = await poll(async () => !isAlive(leaf), 8000);
  if (!gone) throw new Error(`descendant ${leaf} outlived the stop that killed its parent`);
});

await run("an unforced stop reaches them too", async () => {
  const { id, leaf } = await startHolder("graceful");
  strays.push(leaf);
  await app.call("stop_process", { id, force: false });
  const gone = await poll(async () => !isAlive(leaf), 8000);
  if (!gone) throw new Error(`descendant ${leaf} ignored a stop its parent was asked to make`);
});

await run("a process that has already exited is not signalled again", async () => {
  // `node --version` rather than anything quoted: this command is written by
  // one shell on POSIX and another on Windows, and the point here is the
  // bookkeeping, not the quoting.
  const started = await app.call("start_process", { command: "node --version" });
  const done = await poll(async () => {
    const status = await app.call("process_status", { id: started.id });
    return status.processes[0]?.running === false;
  }, 20000);
  if (!done) throw new Error("a command that prints one line was still reported as running");

  // Detaching must not have cost the log capture the pipes it reads.
  const output = await app.call("process_output", { id: started.id, tail_chars: 4000 });
  if (!/^v\d/.test(output.stdout.trim())) throw new Error(`stdout was ${JSON.stringify(output.stdout)}`);

  const stopped = await app.call("stop_process", { id: started.id });
  if (!stopped.already_exited) throw new Error("a dead pid was signalled, which the kernel may have reissued");
});

await run("stopping a job releases the port it was holding", async () => {
  const portFile = path.join(tmp, "port.txt");
  const started = await app.call("start_process", { command: `node "${portLauncher}" "${portFile}"` });
  const port = await poll(
    async () => Number(await fs.readFile(portFile, "utf-8").catch(() => "0")) || undefined,
    20000
  );
  if (!port) throw new Error("the fixture never reported a port");
  if (!(await poll(() => portOpen(port), 20000))) throw new Error(`nothing ever answered on port ${port}`);

  // Unforced, because that is what a caller reaches for first and what used to
  // report a stop while the port stayed taken.
  await app.call("stop_process", { id: started.id, force: false });
  if (!(await poll(async () => !(await portOpen(port)), 10000))) {
    throw new Error(`port ${port} was still held after the stop reported success`);
  }
});

await run("output still in the pipe when the process exits is not lost", async () => {
  // Exiting and running out of output are different events, and this host now
  // reports a process finished at the first of the two. That costs nothing
  // because the pipes are read to the end before `exit` is delivered — which is
  // an assumption about the runtime, not about this code, so it is asserted
  // here rather than trusted. Far more than a pipe buffer holds, so a runtime
  // that stopped draining first would fail this rather than pass by luck.
  const chatty = path.join(tmp, "chatty.mjs");
  await fs.writeFile(chatty, 'process.stdout.write("x".repeat(200000) + "\\nDONE-MARKER\\n");\n', "utf-8");
  const started = await app.call("start_process", { command: `node "${chatty}"` });

  // Polled as tightly as the loop allows: the window this guards closes in the
  // moment between the exit and the last read, and a poll that sleeps through
  // it would report a pass it never earned.
  const done = await poll(async () => {
    const status = await app.call("process_status", { id: started.id });
    return status.processes[0]?.running === false;
  }, 20000, 0);
  if (!done) throw new Error("a command that prints once was still reported as running");

  const output = await app.call("process_output", { id: started.id, tail_chars: 200000 });
  if (!output.stdout.trimEnd().endsWith("DONE-MARKER")) {
    throw new Error(`kept ${output.stdout.length} chars, ending ${JSON.stringify(output.stdout.slice(-40))}`);
  }
});

for (const pid of strays) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
