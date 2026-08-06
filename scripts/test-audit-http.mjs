/**
 * What the audit log says about a call, asserted through a real HTTP request.
 *
 * A tool call that fails is an HTTP 200 carrying `isError` in the body, so the
 * status code cannot tell a refusal from a success. Every denied write was
 * recorded as `ok`, which is the worst kind of wrong: a model that reported work
 * it had been refused could point at a log that agreed with it.
 *
 * The check that was supposed to fix this looked for a Node Buffer, while the
 * SDK writes plain Uint8Array views, so it matched nothing and the log went on
 * saying `ok`. Nothing caught that, because the existing coverage calls the
 * envelope directly on a stand-in server and never crosses HTTP. These checks go
 * over the wire on purpose — the defect lived entirely in the transport.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clc-audit-")));
const workspace = path.join(sandbox, "workspace");
fs.mkdirSync(workspace, { recursive: true });

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e?.message || e}`); failed++; }

const port = 5300 + Math.floor(Math.random() * 90);
const adminPort = port + 1;
const BASE = `http://127.0.0.1:${port}`;
const ADMIN_TOKEN = "audit-http-admin-token";

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
    CLC_CONFIG_DIR: path.join(sandbox, "config"),
    WORKSPACE_PATH: workspace,
    PERMISSION_PROFILE: "workspace",
    CHATGPT_TOOL_PROFILE: "full",
    MCP_SESSION_RECOVERY: "false",
    AUDIT_LOG_PATH: path.join(sandbox, "audit.log"),
    ADMIN_TOKEN,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout?.on("data", (d) => (log += d));
child.stderr?.on("data", (d) => (log += d));

async function waitForHealth(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the host never became healthy");
}

function parseMcpBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const line = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error(`unrecognised MCP body: ${trimmed.slice(0, 200)}`);
  return JSON.parse(line.slice(5).trim());
}

let nextId = 100;
async function callTool(sid, name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: res.status, body: parseMcpBody(await res.text()) };
}

/** The recorded verdict on the most recent call to `tool`. */
async function auditedStatus(tool) {
  const res = await fetch(`http://127.0.0.1:${adminPort}/api/activity?limit=200`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`the activity API answered HTTP ${res.status}`);
  const { entries } = await res.json();
  const entry = entries.find((e) => e.kind === "mcp" && e.tool === tool);
  if (!entry) throw new Error(`no audit entry was recorded for ${tool}`);
  return entry.status;
}

try {
  await waitForHealth();

  const initRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "audit", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  await initRes.text();
  if (!sid) throw new Error("no session id returned");

  // --- a refused write is recorded as a refusal -------------------------
  {
    const outside = path.join(sandbox, "outside.txt");
    const { status, body } = await callTool(sid, "write_file", { path: outside, content: "nope" });
    if (status !== 200) throw new Error(`the denial did not arrive as HTTP 200 but as ${status}`);
    if (!body.result?.isError) throw new Error(`the write was not refused at all: ${JSON.stringify(body).slice(0, 300)}`);
    if (fs.existsSync(outside)) throw new Error("the refused write happened anyway");

    const recorded = await auditedStatus("write_file");
    if (recorded !== "error") {
      throw new Error(`a write the permission profile refused was audited as "${recorded}"`);
    }
    ok("a write refused by the permission profile is audited as an error, not as ok");
  }

  // --- a permitted write is still recorded as ok ------------------------
  //
  // The point of the check is to tell the two apart. A sniffer that marked
  // everything as failed would satisfy the case above and be just as useless.
  {
    const inside = path.join(workspace, "allowed.txt");
    const { body } = await callTool(sid, "write_file", { path: inside, content: "fine" });
    if (body.result?.isError) throw new Error(`a permitted write was refused: ${JSON.stringify(body).slice(0, 300)}`);
    if (!fs.existsSync(inside)) throw new Error("the permitted write did not happen");

    const recorded = await auditedStatus("write_file");
    if (recorded !== "ok") throw new Error(`a write that succeeded was audited as "${recorded}"`);
    ok("a write that succeeds is still audited as ok");
  }

  // --- a file that talks about isError is not a failed call -------------
  //
  // The flag is found by watching the reply rather than parsing it, so a tool
  // returning the same text as content could be read as a verdict on itself.
  // The protocol writes its own flag plainly; content is JSON-escaped, which is
  // what tells them apart.
  {
    const trap = path.join(workspace, "trap.json");
    fs.writeFileSync(trap, '{"isError":true, "note": "this is file content, not a protocol flag"}');
    const { body } = await callTool(sid, "read_text_file", { path: trap });
    if (body.result?.isError) throw new Error("reading the file failed outright");

    const recorded = await auditedStatus("read_text_file");
    if (recorded !== "ok") {
      throw new Error(`reading a file containing "isError":true was audited as "${recorded}"`);
    }
    ok("a file whose contents mention isError does not turn its own read into a failure");
  }
} catch (e) {
  fail("audit over http", e);
  console.error(log.slice(-2000));
} finally {
  child.kill("SIGKILL");
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
