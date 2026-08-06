/**
 * A session that has an SSE stream open must still answer calls.
 *
 * Everything on a session went through one queue, so a standalone GET — which
 * by design does not return until the client closes it — sat at the head of
 * that queue forever. A client that opened the notification stream the protocol
 * offers could not call a single tool afterwards: the POST simply hung, no line
 * appeared in the log, and from the outside the host looked as though it had
 * stopped responding.
 *
 * Serialising POSTs is deliberate and stays; this covers the verbs that were
 * swept in with them.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clc-stream-")));
const workspace = path.join(sandbox, "workspace");
fs.mkdirSync(workspace, { recursive: true });

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e?.message || e}`); failed++; }

const port = 5100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    ADMIN_PORT: String(port + 1),
    CLC_CONFIG_DIR: path.join(sandbox, "config"),
    WORKSPACE_PATH: workspace,
    CHATGPT_TOOL_PROFILE: "full",
    MCP_SESSION_RECOVERY: "false",
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
function post(body, sessionId, signal) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2025-03-26";
  }
  return fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal });
}

async function initialize() {
  const res = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stream", version: "1" } },
  });
  const sid = res.headers.get("mcp-session-id");
  await res.text();
  if (!sid) throw new Error("no session id returned");
  return sid;
}

/** Call a tool, giving up after `ms` rather than hanging the test run. */
async function callTool(sid, name, args, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await post(
      { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
      sid,
      controller.signal
    );
    return parseMcpBody(await res.text());
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`the call hung: no reply within ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Open the standalone SSE stream and hold it, the way a client that wants notifications does. */
async function openStream(sid) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/mcp`, {
    method: "GET",
    headers: { Accept: "text/event-stream", "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`the stream was refused: HTTP ${res.status}`);
  // Read in the background so the connection stays live but nothing awaits it.
  const reader = res.body.getReader();
  void (async () => {
    try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch {}
  })();
  return { close: () => controller.abort() };
}

try {
  await waitForHealth();

  // --- a call still works with the stream open --------------------------
  {
    const sid = await initialize();
    const stream = await openStream(sid);
    try {
      const started = Date.now();
      const result = await callTool(sid, "list_allowed_directories", {});
      const elapsed = Date.now() - started;
      if (result.error) throw new Error(`the call errored: ${JSON.stringify(result.error)}`);
      if (elapsed > 5000) throw new Error(`the call took ${elapsed}ms, so it was queued behind the stream`);
      ok(`a tool call on a session with an open SSE stream answers (${elapsed}ms)`);

      const second = await callTool(sid, "list_allowed_directories", {});
      if (second.error) throw new Error("the second call errored");
      ok("a second call on the same session still answers, so the stream did not poison the queue");
    } finally {
      stream.close();
    }
  }

  // --- the session can still be closed while a stream is open -----------
  {
    const sid = await initialize();
    const stream = await openStream(sid);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${BASE}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
        signal: controller.signal,
      });
      await res.text();
      if (res.status >= 500) throw new Error(`DELETE answered HTTP ${res.status}`);
      ok(`a session with an open stream can still be closed (HTTP ${res.status})`);
    } catch (e) {
      if (e.name === "AbortError") fail("delete with stream open", new Error("DELETE hung behind the stream"));
      else fail("delete with stream open", e);
    } finally {
      clearTimeout(timer);
      stream.close();
    }
  }

  // --- DELETE does not abandon a call that is already running -----------
  //
  // Narrowing the queue to POSTs let DELETE overtake a tool call in flight and
  // close the transport out from under it. The call was then never answered at
  // all — not an error, no reply — so the client waited on a request the host
  // had already forgotten. Closing an idle session, which is what the case
  // above covers, cannot see this: the call has to be running when DELETE
  // arrives.
  {
    const sid = await initialize();
    const inFlight = callTool(sid, "run_command", { command: "node -e \"setTimeout(()=>{},3000)\"" }, 20000);
    await new Promise((r) => setTimeout(r, 700));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const deleted = await fetch(`${BASE}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
        signal: controller.signal,
      });
      await deleted.text();

      const result = await inFlight;
      if (result.error) throw new Error(`the in-flight call errored: ${JSON.stringify(result.error)}`);
      if (!result.result) throw new Error(`the in-flight call returned no result: ${JSON.stringify(result)}`);
      ok("a tool call already running is still answered when the client closes the session under it");
    } catch (e) {
      if (e.name === "AbortError") fail("delete during a call", new Error("DELETE itself hung"));
      else fail("delete during a call", e);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- a closed session says so instead of going quiet ------------------
  //
  // The session entry is held for a grace period after DELETE so a tool call
  // already running can finish, but its transport will not answer anything new.
  // A POST arriving in that window was accepted and then never replied to, so
  // the client waited on a session that no longer existed.
  {
    const sid = await initialize();
    const deleted = await fetch(`${BASE}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" },
    });
    await deleted.text();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "list_allowed_directories", arguments: {} } },
        sid,
        controller.signal
      );
      const body = await res.text();
      if (res.status === 200) throw new Error("a closed session answered as though it were open");
      if (!/session/i.test(body)) throw new Error(`the refusal does not mention the session: ${body.slice(0, 200)}`);
      ok(`a call on a session closed by DELETE is refused rather than left hanging (HTTP ${res.status})`);
    } catch (e) {
      if (e.name === "AbortError") fail("post after delete", new Error("the call hung after DELETE"));
      else fail("post after delete", e);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- POSTs on one session are still serialised ------------------------
  //
  // Asserted rather than assumed: this is the behaviour the queue exists for,
  // and the fix above narrowed the queue rather than removing it.
  {
    const sid = await initialize();
    const started = Date.now();
    const both = await Promise.all([
      callTool(sid, "run_command", { command: "node -e \"setTimeout(()=>{},1500)\"" }, 30000),
      callTool(sid, "run_command", { command: "node -e \"setTimeout(()=>{},1500)\"" }, 30000),
    ]);
    const elapsed = Date.now() - started;
    if (both.some((r) => r.error)) throw new Error("one of the two calls errored");
    if (elapsed < 2500) throw new Error(`both calls ran in ${elapsed}ms — they were not serialised`);
    ok(`two calls on one session still run one after the other (${elapsed}ms)`);
  }
} catch (e) {
  fail("mcp stream", e);
  console.error(log.slice(-2000));
} finally {
  child.kill("SIGKILL");
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
