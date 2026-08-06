/**
 * Make the host do a real job, and watch it happen.
 *
 * The test suite proves each tool behaves; this proves the host can carry a
 * piece of work from nothing to a commit and a running server, over MCP, the
 * way a client drives it. Everything happens in a throwaway directory that is
 * removed at the end.
 *
 *   node scripts/try-a-job.mjs            keep going after a failed step
 *   node scripts/try-a-job.mjs --keep     leave the directory behind to inspect
 */
import { spawn } from "child_process";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");

// A port nobody is likely to hold, for the host itself. The job's own server
// picks port 0 and reports what it was given.
const mcpPort = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${mcpPort}`;

const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-job-"));
let step = 0;
let failures = 0;

const say = (text) => console.log(text);
const heading = (text) => say(`\n\x1b[1m${++step}. ${text}\x1b[0m`);
const good = (text) => say(`   \x1b[32m✓\x1b[0m ${text}`);
const bad = (text) => { failures++; say(`   \x1b[31m✗ ${text}\x1b[0m`); };
const check = (cond, text) => (cond ? good(text) : bad(text));

// --------------------------------------------------------------- the host

say(`workspace: ${workdir}`);
say(`starting the host on ${BASE} …`);

const host = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(mcpPort + 1),
    // The job writes, runs commands and commits, so it needs a profile that
    // permits all three inside a root it was given — not a wider one.
    CLC_PERMISSION_PROFILE: "workspace",
    WORKSPACE_PATH: workdir,
    CHATGPT_TOOL_PROFILE: "full",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hostLog = "";
host.stdout.on("data", (d) => (hostLog += d));
host.stderr.on("data", (d) => (hostLog += d));

const poll = async (check_, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check_()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const settle = (v) => { socket.destroy(); resolve(v); };
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
    setTimeout(() => settle(false), 1000);
  });

let sid;
async function rpc(body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!sid) sid = res.headers.get("mcp-session-id");
  // A streamable-HTTP reply arrives as one SSE frame; a plain one does not.
  const frame = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(frame ? frame.slice(6) : text);
}

/** Call a tool the way a client does, and hand back its structured result. */
async function tool(name, args) {
  const out = await rpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e6),
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (out.error) throw new Error(`${name}: ${JSON.stringify(out.error)}`);
  const result = out.result ?? {};
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent?.data ?? result;
}

try {
  const up = await poll(async () => {
    try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
  }, 30000);
  if (!up) throw new Error(`the host never became healthy. Its output was:\n${hostLog}`);

  await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "try-a-job", version: "1" } },
  });
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  good(`host is up and offering ${listed.result?.tools?.length ?? 0} tools`);

  // ------------------------------------------------------------ write code
  heading("Write a small project");
  await tool("write_file", {
    path: path.join(workdir, "sum.mjs"),
    // The bug is deliberate: `<=` walks one past the end and adds undefined.
    content: "export function sum(xs) {\n  let total = 0;\n  for (let i = 0; i <= xs.length; i++) total += xs[i];\n  return total;\n}\n",
  });
  await tool("write_file", {
    path: path.join(workdir, "test.mjs"),
    content:
      'import { sum } from "./sum.mjs";\n' +
      'const got = sum([1, 2, 3]);\n' +
      'if (got !== 6) { console.error(`sum([1,2,3]) = ${got}, expected 6`); process.exit(1); }\n' +
      'console.log("sum works");\n',
  });
  const listing = await tool("list_directory", { path: workdir });
  good(`wrote ${(listing.entries ?? listing.files ?? []).length || 2} files into the workspace`);

  // ------------------------------------------------------- run it, failing
  heading("Run the test — it should fail");
  const failing = await tool("run_command", { command: "node test.mjs", working_directory: workdir });
  check(failing.exit_code !== 0, `the test failed as intended (exit ${failing.exit_code})`);
  say(`     ${String(failing.stderr || failing.stdout).trim().split("\n")[0]}`);

  // ---------------------------------------------------------------- fix it
  heading("Fix the bug with an edit");
  await tool("edit_file", {
    path: path.join(workdir, "sum.mjs"),
    old_text: "i <= xs.length",
    new_text: "i < xs.length",
  });
  const passing = await tool("run_command", { command: "node test.mjs", working_directory: workdir });
  check(passing.exit_code === 0, `the test passes after the edit (exit ${passing.exit_code})`);
  say(`     ${String(passing.stdout).trim()}`);

  // ----------------------------------------------------------- search it
  heading("Find the code again");
  const hits = await tool("grep", { pattern: "xs\\.length", path: workdir, output_mode: "content" });
  check(/sum\.mjs/.test(String(hits.output)), "grep found the function it had just edited");
  say(`     ${String(hits.output).trim().split("\n")[0]}`);

  // ------------------------------------------------------------- commit it
  heading("Put it under version control");
  await tool("run_command", { command: "git init -q && git config user.email you@example.invalid && git config user.name You", working_directory: workdir });
  await tool("git_add", { path: workdir });
  const committed = await tool("git_commit", { path: workdir, message: "Add sum, with a test that proves it" });
  check(!!committed, "git_commit answered");
  const log = await tool("git_log", { path: workdir, count: 1 });
  check(log.commits?.length === 1, `git_log shows: ${log.commits?.[0] ?? "(nothing)"}`);
  const status = await tool("git_status", { path: workdir });
  check(/clean|nothing/i.test(String(status.output)) || String(status.output).trim().split("\n").length <= 1,
    `git_status: ${String(status.output).trim().split("\n")[0] || "(clean)"}`);

  // -------------------------------------------------- run and stop a server
  heading("Start a server, use it, then stop it");
  await tool("write_file", {
    path: path.join(workdir, "serve.mjs"),
    content:
      'import http from "http";\nimport fs from "fs";\n' +
      'import { sum } from "./sum.mjs";\n' +
      'const server = http.createServer((_, res) => res.end(String(sum([1, 2, 3]))));\n' +
      'server.listen(0, "127.0.0.1", () => fs.writeFileSync("port.txt", String(server.address().port)));\n' +
      "setTimeout(() => process.exit(0), 120000);\n",
  });
  const job = await tool("start_process", { command: "node serve.mjs", working_directory: workdir });
  const port = await (async () => {
    for (let i = 0; i < 100; i++) {
      const value = Number(await fs.readFile(path.join(workdir, "port.txt"), "utf-8").catch(() => "0"));
      if (value) return value;
      await new Promise((r) => setTimeout(r, 200));
    }
    return 0;
  })();
  check(port > 0 && (await poll(() => portOpen(port), 15000)), `the job is serving on port ${port}`);
  const answer = port ? await (await fetch(`http://127.0.0.1:${port}/`)).text() : "";
  check(answer === "6", `it answers with the sum it just fixed: ${JSON.stringify(answer)}`);

  await tool("stop_process", { id: job.id });
  check(await poll(async () => !(await portOpen(port)), 10000), "the port is free again after the stop");
  const after = await tool("process_status", { id: job.id });
  check(after.processes?.[0]?.running === false, "the job reports finished");
} catch (error) {
  bad(error.message);
} finally {
  host.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  host.kill("SIGKILL");
  if (keep) say(`\nleft behind for inspection: ${workdir}`);
  else await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
}

say(failures ? `\n\x1b[31m${failures} step(s) failed.\x1b[0m` : "\n\x1b[32mThe host did the whole job.\x1b[0m");
process.exit(failures ? 1 : 0);
