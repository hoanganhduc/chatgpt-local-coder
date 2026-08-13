/**
 * The shared port probes.
 *
 * Three callers depend on these two functions and each one used to carry its
 * own version or none at all: the duplicate-instance preflight in `up`, the
 * health wait before `up` connects a tunnel, and `tunnel connect
 * --wait-for-server`. They are asserted here directly, because the failure that
 * motivated them is not visible from any one command's output — a probe that
 * answers "free" for a taken port, or "healthy" for a port nobody is serving,
 * turns into a second host stealing the first one's tunnel.
 */
import http from "http";
import net from "net";

import {
  healthUrlForMcpUrl,
  portInUse,
  waitForMcpHealth,
  waitForServerHealth,
} from "../dist/lib/port-probe.js";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** Hold a port the way a running instance would. */
function holdPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

/** A port number nothing is listening on: bound to learn it, then released. */
async function freePort() {
  const held = await holdPort();
  await held.close();
  return held.port;
}

/** Serve one fixed status on /health. */
function serveHealth(status) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === "/health" ? status : 404).end("");
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

// ---------------------------------------------------------------- portInUse

await checkAsync("portInUse sees a held port and not a free one", async () => {
  const held = await holdPort();
  try {
    assert((await portInUse(held.port)) === true, `a listening socket should be detected on ${held.port}`);
  } finally {
    await held.close();
  }
  assert((await portInUse(held.port)) === false, "the port should read as free once released");
});

await checkAsync("portInUse leaves the port bindable", async () => {
  // The probe binds to find out. If it did not close, the preflight would make
  // the very port it was clearing unusable to the server it is about to start.
  const port = await freePort();
  assert((await portInUse(port)) === false, "a free port");
  assert((await portInUse(port)) === false, "the probe's own listener would have shown up here");

  const after = net.createServer();
  await new Promise((resolve, reject) => {
    after.once("error", reject);
    after.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((done) => after.close(done));
});

// -------------------------------------------------------- waitForServerHealth

await checkAsync("waitForServerHealth returns as soon as /health answers", async () => {
  const server = await serveHealth(200);
  try {
    const started = Date.now();
    assert((await waitForServerHealth(server.port, 10_000)) === true, "a healthy server was not detected");
    assert(Date.now() - started < 5_000, "it should return on the first successful probe, not at the deadline");
  } finally {
    await server.close();
  }
});

await checkAsync("waitForServerHealth does not accept a non-200 as healthy", async () => {
  // A server that is listening but failing its own health check is exactly the
  // state a tunnel must not be published over.
  const server = await serveHealth(503);
  try {
    assert((await waitForServerHealth(server.port, 1_500)) === false, "503 was treated as ready");
  } finally {
    await server.close();
  }
});

await checkAsync("waitForServerHealth gives up at the deadline when nothing listens", async () => {
  const port = await freePort();
  const started = Date.now();
  assert((await waitForServerHealth(port, 1_500)) === false, "an unserved port was reported healthy");
  const elapsed = Date.now() - started;
  assert(elapsed >= 1_000, `it returned after ${elapsed}ms — the deadline was not honoured`);
  assert(elapsed < 8_000, `it overran the deadline by ${elapsed - 1_500}ms`);
});

await checkAsync("waitForServerHealth stops early when the process it is waiting on has died", async () => {
  // Without this, `up` waited the full timeout after a child that had already
  // crashed, and only then reported the failure.
  const port = await freePort();
  const started = Date.now();
  assert((await waitForServerHealth(port, 30_000, () => false)) === false, "a dead child should not be waited on");
  assert(Date.now() - started < 2_000, "it kept waiting for a process that is gone");
});

await checkAsync("an MCP URL override and its readiness probe use the same origin", async () => {
  const server = await serveHealth(200);
  try {
    const mcpUrl = `http://127.0.0.1:${server.port}/custom/mcp?ignored=yes`;
    assert(healthUrlForMcpUrl(mcpUrl) === `http://127.0.0.1:${server.port}/health`, "wrong health URL");
    assert((await waitForMcpHealth(mcpUrl, 2_000)) === true, "the custom MCP origin was not probed");
  } finally {
    await server.close();
  }
});

await checkAsync("an unreachable MCP URL override cannot borrow the configured server's health", async () => {
  const configured = await serveHealth(200);
  const unavailable = await freePort();
  try {
    assert(
      (await waitForMcpHealth(`http://127.0.0.1:${unavailable}/mcp`, 1_000)) === false,
      `the healthy server on ${configured.port} satisfied a probe for ${unavailable}`
    );
  } finally {
    await configured.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
