/**
 * End-to-end proof of acceptance gate 4: a write outside the workspace roots is
 * denied under the default profile and permitted under "open" — exercised
 * through a real MCP tools/call, not by calling the permission engine directly.
 *
 * This is what verifies the wiring config -> setPermissionContext -> tool.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clc-perm-e2e-")));
const workspace = path.join(sandbox, "workspace");
const outside = path.join(sandbox, "outside");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

async function waitForHealth(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** Parse either a JSON body or an SSE frame carrying one. */
function parseMcpBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`unrecognised MCP body: ${trimmed.slice(0, 200)}`);
  return JSON.parse(dataLine.slice(5).trim());
}

async function mcpSession(port) {
  const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "perm-e2e", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no mcp-session-id returned");

  let nextId = 2;
  return async function call(name, args) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    return parseMcpBody(await res.text());
  };
}

/** A tool call failed if the JSON-RPC errored or the result is flagged isError. */
function callFailed(response) {
  if (response.error) return true;
  return response.result?.isError === true;
}

function callText(response) {
  if (response.error) return response.error.message || JSON.stringify(response.error);
  return (response.result?.content || []).map((c) => c.text || "").join("\n");
}

function startServer(env) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      CLC_CONFIG_DIR: path.join(sandbox, "config"),
      WORKSPACE_PATH: workspace,
      CHATGPT_TOOL_PROFILE: "full",
      MCP_SESSION_RECOVERY: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  return { child, log: () => log };
}

const basePort = 4700 + Math.floor(Math.random() * 100);

// --- default (workspace) profile ----------------------------------------
{
  const port = basePort;
  const server = startServer({ PORT: String(port), ADMIN_PORT: String(port + 1) });
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`);
    if (health.permissionProfile !== "workspace") throw new Error(`profile is ${health.permissionProfile}`);

    const call = await mcpSession(port);

    const insidePath = path.join(workspace, "allowed.txt");
    const inside = await call("write_file", { path: insidePath, content: "inside" });
    if (callFailed(inside)) throw new Error(`write inside the root was denied: ${callText(inside)}`);
    if (fs.readFileSync(insidePath, "utf-8") !== "inside") throw new Error("file not written");
    ok("workspace profile: write_file inside the root succeeds");

    const outsidePath = path.join(outside, "escaped.txt");
    const out = await call("write_file", { path: outsidePath, content: "escaped" });
    if (!callFailed(out)) throw new Error("write outside the root was ALLOWED");
    if (fs.existsSync(outsidePath)) throw new Error("the denied write still created the file");
    if (!callText(out).toLowerCase().includes("permission denied")) {
      throw new Error(`denial message is not recognisable: ${callText(out)}`);
    }
    ok("workspace profile: write_file outside the roots is denied (gate 4)");

    // A read outside the roots is still allowed under this profile.
    fs.writeFileSync(path.join(outside, "readable.txt"), "readable", "utf-8");
    const read = await call("read_text_file", { path: path.join(outside, "readable.txt") });
    if (callFailed(read)) throw new Error(`read outside the root was denied: ${callText(read)}`);
    ok("workspace profile: read_text_file outside the roots still succeeds");

    // Every write-capable tool must be covered, not just write_file.
    const cases = [
      ["write_file_base64", { path: path.join(outside, "b64.bin"), content: "aGk=" }],
      ["create_directory", { path: path.join(outside, "newdir") }],
      ["apply_patch", { path: path.join(outside, "readable.txt"), patch: "@@\n-readable\n+patched\n" }],
      ["copy_file", { source: path.join(outside, "readable.txt"), destination: path.join(outside, "copy.txt") }],
      ["move_file", { source: path.join(outside, "readable.txt"), destination: path.join(outside, "moved.txt") }],
      ["delete_file", { path: path.join(outside, "readable.txt") }],
      ["edit_file", { path: path.join(outside, "readable.txt"), old_text: "readable", new_text: "x" }],
      ["replace_regex", { path: path.join(outside, "readable.txt"), pattern: "readable", replacement: "x" }],
      ["multi_edit", { path: path.join(outside, "readable.txt"), edits: [{ old_text: "readable", new_text: "x" }] }],
    ];
    const leaked = [];
    for (const [tool, args] of cases) {
      const res = await call(tool, args);
      if (!callFailed(res)) leaked.push(tool);
    }
    if (leaked.length) throw new Error(`these tools wrote outside the roots: ${leaked.join(", ")}`);
    ok(`all ${cases.length} write-capable tools are denied outside the roots`);

    // The source file must be untouched by any of the attempts above.
    if (fs.readFileSync(path.join(outside, "readable.txt"), "utf-8") !== "readable") {
      throw new Error("a denied tool still modified the file outside the roots");
    }
    ok("no denied tool left a side effect outside the roots");
  } catch (e) {
    fail("workspace profile e2e", `${e.message}\n${server.log().slice(-2000)}`);
  } finally {
    server.child.kill();
  }
}

// --- open profile --------------------------------------------------------
{
  const port = basePort + 10;
  const server = startServer({
    PORT: String(port),
    ADMIN_PORT: String(port + 1),
    CLC_PERMISSION_PROFILE: "open",
  });
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`);
    if (health.permissionProfile !== "open") throw new Error(`profile is ${health.permissionProfile}`);

    const call = await mcpSession(port);
    const target = path.join(outside, "open-profile.txt");
    const res = await call("write_file", { path: target, content: "open" });
    if (callFailed(res)) throw new Error(`open profile denied a write: ${callText(res)}`);
    if (fs.readFileSync(target, "utf-8") !== "open") throw new Error("file not written under open profile");
    ok("open profile: write_file outside the roots is permitted (gate 4)");
  } catch (e) {
    fail("open profile e2e", `${e.message}\n${server.log().slice(-2000)}`);
  } finally {
    server.child.kill();
  }
}

// --- readonly profile ----------------------------------------------------
{
  const port = basePort + 20;
  const server = startServer({
    PORT: String(port),
    ADMIN_PORT: String(port + 1),
    CLC_PERMISSION_PROFILE: "readonly",
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    const call = await mcpSession(port);

    const res = await call("write_file", { path: path.join(workspace, "readonly.txt"), content: "nope" });
    if (!callFailed(res)) throw new Error("readonly profile allowed a write inside the root");
    ok("readonly profile: a write inside the root is still denied");

    const read = await call("read_text_file", { path: path.join(workspace, "allowed.txt") });
    if (callFailed(read)) throw new Error(`readonly profile denied a read: ${callText(read)}`);
    ok("readonly profile: reads still work");
  } catch (e) {
    fail("readonly profile e2e", `${e.message}\n${server.log().slice(-2000)}`);
  } finally {
    server.child.kill();
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
