/**
 * Integration test: MCP session init, tool call, stale-session recovery.
 * Requires server running on PORT (default 3000).
 */
const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function mcpPost(path, body, sessionId, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function initialize(path = "/mcp") {
  const { status, headers, json } = await mcpPost(
    path,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-mcp-session", version: "1.0.0" },
      },
    },
    null
  );

  if (status !== 200) throw new Error(`initialize HTTP ${status}: ${JSON.stringify(json)}`);
  const sessionId = headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing mcp-session-id header");
  return { sessionId, json };
}

await run("health endpoint", async () => {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error(JSON.stringify(data));
});

let sessionId;
await run("initialize session on /mcp", async () => {
  const out = await initialize("/mcp");
  sessionId = out.sessionId;
});

await run("tools/list with valid session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (!json?.result?.tools?.some((t) => t.name === "run_command")) {
    throw new Error("run_command not in tools/list");
  }
});

// OpenAI's connector announces itself to a new tunnel with `server/discover`,
// its own extension rather than a protocol method, and sends it before any
// `initialize`. That used to land on the sessionless branch and come back as
// `400 Bad Request`, which reads as a broken server rather than as a declined
// extension: the live connector tried twice, five seconds apart, then stopped,
// and every later chat showed Local Coder with no tools in it.
await run("unknown method without a session is declined, not refused", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: "openai-mcp-discover", method: "server/discover" },
    null
  );
  if (status !== 200) throw new Error(`expected HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  if (json?.error?.code !== -32601) {
    throw new Error(`expected -32601, got ${JSON.stringify(json)}`);
  }
  if (json?.id !== "openai-mcp-discover") {
    throw new Error(`request id not echoed: ${JSON.stringify(json)}`);
  }
});

// The two paths agreeing is the whole point of the fix: the SDK has always
// answered this way once a session exists, and the sessionless answer differing
// from it is what made an absent method look like a fault.
await run("unknown method answers the same with a session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 20, method: "server/discover" },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`expected HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  if (json?.error?.code !== -32601) {
    throw new Error(`expected -32601, got ${JSON.stringify(json)}`);
  }
});

// The guard against fixing this too broadly. `tools/list` is a method this
// server does implement, so a sessionless one is genuinely missing its session
// and must keep saying so — answering `-32601` there would report the method as
// absent when a session was the only thing lacking.
await run("known method without a session still reports the missing session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} },
    null
  );
  if (status !== 400) throw new Error(`expected HTTP 400, got ${status}: ${JSON.stringify(json)}`);
  if (!/Mcp-Session-Id/i.test(json?.error?.message ?? "")) {
    throw new Error(`expected a session-id message, got ${JSON.stringify(json)}`);
  }
});

await run("stale session auto-recovery", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000099";
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo stale-test" } },
    },
    fakeId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  if (status !== 200) {
    throw new Error(`expected recovery HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  }
  if (!json?.result) throw new Error(`recovery missing result: ${JSON.stringify(json)}`);
});

await run("re-initialize with stale session header", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000088";
  const { status, headers, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-reinit", version: "1.0.0" },
      },
    },
    fakeId
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const newSession = headers.get("mcp-session-id");
  if (!newSession) throw new Error("missing new session id");
  sessionId = newSession;
});

await run("run_command after re-init", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { command: process.platform === "win32" ? "echo mcp-ok" : "echo mcp-ok" },
      },
    },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const text = JSON.stringify(json?.result ?? json);
  if (!text.includes("mcp-ok") && !json?.result?.content) {
    throw new Error(`unexpected result: ${text.slice(0, 300)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);