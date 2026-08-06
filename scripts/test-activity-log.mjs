import assert from "node:assert/strict";
import { appendActivity, getRecentActivity, logMcpRequest, summarizeToolArgs } from "../dist/lib/activity-log.js";
import { installLogTimestamps } from "../dist/lib/log-timestamp.js";

// summarizeToolArgs
assert.equal(summarizeToolArgs("run_command", { command: "npm test" }), "npm test");
assert.equal(summarizeToolArgs("read_text_file", { path: "C:\\foo.ts" }), "C:\\foo.ts");

// append + retrieve
const before = getRecentActivity(500).length;
appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: "pattern: foo" });
assert.equal(getRecentActivity(500).length, before + 1);
const latest = getRecentActivity(1)[0];
assert.equal(latest.tool, "grep");
assert.equal(latest.kind, "tool");

// logMcpRequest tools/call
logMcpRequest(
  { method: "tools/call", params: { name: "read_text_file", arguments: { path: "/tmp/x" } } },
  "sess-abc-123",
  42,
  200
);
const mcp = getRecentActivity(5).find((e) => e.kind === "mcp" && e.tool === "read_text_file");
assert.ok(mcp, "expected mcp tools/call entry");
assert.equal(mcp.client, "chatgpt");
assert.equal(mcp.duration_ms, 42);
assert.equal(mcp.summary, "/tmp/x");

// filter since
const all = getRecentActivity(500);
const since = all[1]?.id;
if (since) {
  const newer = getRecentActivity(500, since);
  assert.ok(newer.length < all.length);
}

// error logging with message
logMcpRequest(
  { method: "tools/call", params: { name: "write_file", arguments: { path: "/x" } } },
  "sess-err",
  2,
  400,
  "Bad Request: Server not initialized"
);
const errEntry = getRecentActivity(3).find((e) => e.status === "error" && e.tool === "write_file");
assert.ok(errEntry, "expected error activity entry");
assert.equal(errEntry.summary, "Bad Request: Server not initialized");

// A tool failure is an HTTP 200 carrying isError, so the status code alone used
// to record every refused write as ok — the log agreed with a model reporting
// work it had never done.
logMcpRequest(
  { method: "tools/call", params: { name: "delete_file", arguments: { path: "/x" } } },
  "sess-tool-fail",
  7,
  200,
  undefined,
  true
);
const toolFail = getRecentActivity(3).find((e) => e.tool === "delete_file");
assert.ok(toolFail, "expected an entry for the failed call");
assert.equal(toolFail.status, "error", "a tool failure inside a 200 was logged as ok");

logMcpRequest(
  { method: "tools/call", params: { name: "glob", arguments: { pattern: "*" } } },
  "sess-tool-ok",
  7,
  200,
  undefined,
  false
);
assert.equal(getRecentActivity(3).find((e) => e.tool === "glob").status, "ok");

// ---------------------------------------------------------------- log labels
// A tool that fails or refuses still answers HTTP 200 — the failure rides in
// the envelope. Tagging that "[MCP ERROR] HTTP 200" put a working permission
// check under the same word and status code as a transport fault.
function captureWarn(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try { fn(); } finally { console.warn = original; }
  return lines;
}

const toolFailed = captureWarn(() =>
  logMcpRequest(
    { method: "tools/call", params: { name: "write_file", arguments: { path: "/nope" } } },
    "sess-envelope",
    5,
    200,
    "Permission denied: write outside workspace roots.",
    true
  )
);
assert.equal(toolFailed.length, 1);
assert.match(toolFailed[0], /^\[MCP FAIL\] tools\/call write_file/);
assert.ok(!/HTTP 200/.test(toolFailed[0]), "a 200 is not an HTTP error and must not be printed as one");

const transportFailed = captureWarn(() =>
  logMcpRequest({ method: "tools/list" }, "sess-http", 3, 400, "Bad Request")
);
assert.equal(transportFailed.length, 1);
assert.match(transportFailed[0], /^\[MCP ERROR\] HTTP 400 tools\/list/);

const blocked = captureWarn(() =>
  appendActivity({ kind: "tool", tool: "run_command", status: "blocked", summary: "denied by rule" })
);
assert.equal(blocked.length, 1);
assert.match(blocked[0], /^\[MCP BLOCKED\] tools\/call run_command — denied by rule/);

// ------------------------------------------------------------- timestamps
// Under a service the log file is stdout on disk. Without a stamp per line a
// crash cannot be lined up against the requests that preceded it — which is
// exactly the state four crashes were diagnosed in, and could not be.
const stamped = [];
const realLog = console.log;
console.log = (...args) => stamped.push(args.join(" "));
try {
  installLogTimestamps();
  installLogTimestamps(); // idempotent: a second install must not double-stamp
  console.log("[MCP] hello");
  console.log("");
  console.log();
} finally {
  console.log = realLog;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
assert.match(stamped[0], ISO, "a log line must carry a timestamp");
assert.match(stamped[0], /\[MCP\] hello$/, "the original message must survive intact");
assert.equal(stamped[0].split("Z ").length, 2, "installing twice must not stack two prefixes");
assert.equal(stamped[1], "", "a blank spacer must stay blank, not become a bare timestamp");
assert.equal(stamped[2], "", "an argument-less call must not produce a lone timestamp");

console.log("activity-log: ok");
