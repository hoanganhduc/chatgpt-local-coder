/**
 * Failure-path tests for the shared test harness (REV-R04).
 * Every case is bounded by an outer watchdog: if a case hangs, the watchdog
 * fails it and the registry cleanup still runs. Real server children use
 * run-owned ports and a synthetic environment; no production process is used
 * or stopped. Run: node scripts/test-project-memory-harness.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Deadline,
  OwnedChild,
  allocPort,
  allocPortPair,
  boundedAwait,
  buildClcServerEnv,
  fetchJsonBounded,
  makeFixtureDir,
  probeCandidateHealth,
  registryCleanup,
  startStub,
} from "./test-lib/mcp-test-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Hermetic process environment before any app code is imported by children:
// children get their env from buildClcServerEnv, so nothing here leaks.
const results = [];
let passed = 0;
let failed = 0;
function record(name, status, expected, actual) {
  results.push({ name, status, expected: String(expected), actual: String(actual) });
  console.log(`${status === "pass" ? "OK  " : "FAIL"} ${name}: expected=${expected} actual=${actual}`);
  status === "pass" ? passed++ : failed++;
}
function check(name, cond, expected, actual) {
  record(name, cond ? "pass" : "fail", expected, actual);
}

/** Outer watchdog: the case itself must settle within the deadline; a hang
 *  surfaces as a boundedAwait rejection, which is recorded as a failure. */
async function guarded(name, deadlineMs, fn) {
  const watchdog = new Deadline(deadlineMs);
  try {
    await boundedAwait(watchdog, fn(watchdog), name);
  } catch (err) {
    check(name, false, "no error", String(err?.message || err));
    return;
  }
}

const main = async () => {
  // 1. Pending headers: a peer that accepts but never responds.
  await guarded("pending headers bounded reject", 6000, async (d) => {
    const port = await allocPort();
    await startStub(port, { mode: "pendingHeaders" }).listening;
    const t0 = performance.now();
    let err = null;
    try {
      await fetchJsonBounded(d, `http://127.0.0.1:${port}/health`, { timeoutMs: 1500 });
    } catch (e) {
      err = e;
    }
    const elapsed = performance.now() - t0;
    check(
      "pending headers bounded reject",
      err !== null && /no response headers/.test(err.message) && elapsed < 5000,
      "reject within budget",
      `${err?.message} (${Math.round(elapsed)}ms)`
    );
  });

  // 2. HTTP 200 whose body never ends.
  await guarded("pending body bounded reject", 6000, async (d) => {
    const port = await allocPort();
    await startStub(port, { mode: "pendingBody" }).listening;
    const t0 = performance.now();
    let err = null;
    try {
      await fetchJsonBounded(d, `http://127.0.0.1:${port}/health`, { timeoutMs: 1500 });
    } catch (e) {
      err = e;
    }
    const elapsed = performance.now() - t0;
    check(
      "pending body bounded reject",
      err !== null && /never ended/.test(err.message) && elapsed < 5000,
      "reject within budget",
      `${err?.message} (${Math.round(elapsed)}ms)`
    );
  });

  // 3. Invalid JSON body.
  await guarded("invalid JSON reported", 6000, async (d) => {
    const port = await allocPort();
    const stub = startStub(port, { mode: "respond", rawText: "not-json" });
    await stub.listening;
    let err = null;
    try {
      await fetchJsonBounded(d, `http://127.0.0.1:${port}/health`, { timeoutMs: 1500 });
    } catch (e) {
      err = e;
    }
    check("invalid JSON reported", err !== null && /invalid JSON/.test(err.message), "invalid JSON error", String(err?.message));
  });

  // 4. Wrong instance: a foreign HTTP 200 with a different identity.
  await guarded("wrong instance rejected", 6000, async (d) => {
    const port = await allocPort();
    await startStub(port, { mode: "respond", body: { status: "ok", runtime_pid: 12345, runtime_instance_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }).listening;
    const res = await probeCandidateHealth(d, port, 99999);
    check("wrong instance rejected", res.ok === false && res.kind === "wrong-instance", "wrong-instance", JSON.stringify({ ok: res.ok, kind: res.kind }));
  });

  // 5. Child exits early (exit observed before waitExit is called).
  await guarded("early child exit observed", 10000, async (d) => {
    const child = new OwnedChild(process.execPath, ["-e", "process.exit(3)"], { name: "early-exit" });
    await d.sleep(800);
    const info = await child.waitExit(d);
    check("early child exit observed", info?.code === 3, "code 3", JSON.stringify(info));
  });

  // 6. Already-exited child: repeated waitExit settles immediately.
  await guarded("already-exited child settles", 10000, async (d) => {
    const child = new OwnedChild(process.execPath, ["-e", "process.exit(0)"], { name: "already-exited" });
    const first = await child.waitExit(d);
    const t0 = performance.now();
    const second = await child.waitExit(d);
    const elapsed = performance.now() - t0;
    check(
      "already-exited child settles",
      first?.code === 0 && second?.code === 0 && elapsed < 1000,
      "immediate resolve twice",
      JSON.stringify({ first, second, elapsed: Math.round(elapsed) })
    );
  });

  // 7. Spawn error (nonexistent binary).
  await guarded("spawn error captured", 10000, async (d) => {
    const child = new OwnedChild(path.join(repoRoot, "definitely-not-a-binary-xyz"), [], { name: "spawn-error" });
    const info = await child.waitExit(d, 5000);
    check("spawn error captured", info?.code === "spawn-error" || child.spawnError !== null, "spawn-error", JSON.stringify(info));
  });

  // 8. Admin-port conflict: candidate must fail with a clear bind error and
  //    must not disturb the run-owned stub holding the admin port.
  await guarded("admin-port conflict fails cleanly", 60000, async (d) => {
    const { mcpPort, adminPort } = await allocPortPair();
    const home = makeFixtureDir("clc-harness-home-");
    const ws = makeFixtureDir("clc-harness-ws-");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# fixture\nADMINCONFLICT-MARKER\n");
    const base = makeFixtureDir("clc-harness-base-");
    const stub = startStub(adminPort, { mode: "respond", body: { status: "stub", marker: "admin-stub" } });
    await stub.listening;
    const env = buildClcServerEnv(base, home, ws, {
      PORT: String(mcpPort),
      ADMIN_PORT: String(adminPort),
      ADMIN_TOKEN: "fixture-admin-token",
    });
    const child = new OwnedChild(process.execPath, ["dist/index.js"], { cwd: repoRoot, env, name: "admin-conflict" });
    const info = await child.waitExit(d, 45000);
    const stillStub = await fetchJsonBounded(d, `http://127.0.0.1:${adminPort}/health`, { timeoutMs: 3000 }).then((r) => r.body?.marker).catch(() => null);
    check(
      "admin-port conflict fails cleanly",
      info?.code === 1 && /Admin port .* is already in use/.test(child.output) && stillStub === "admin-stub",
      "exit 1 + admin bind error + stub untouched",
      JSON.stringify({ info, hasBindError: /Admin port .* is already in use/.test(child.output), stillStub })
    );
  });

  // 9. Foreign HTTP 200 on the MCP port: identity check rejects it; the
  //    candidate that cannot bind exits non-zero; the stub is never stopped.
  await guarded("foreign HTTP 200 rejected", 60000, async (d) => {
    const { mcpPort, adminPort } = await allocPortPair();
    const home = makeFixtureDir("clc-harness-home-");
    const ws = makeFixtureDir("clc-harness-ws-");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# fixture\nFOREIGN200-MARKER\n");
    const base = makeFixtureDir("clc-harness-base-");
    const stub = startStub(mcpPort, { mode: "respond", body: { status: "ok", name: "foreign" } });
    await stub.listening;
    const env = buildClcServerEnv(base, home, ws, {
      PORT: String(mcpPort),
      ADMIN_PORT: String(adminPort),
      ADMIN_TOKEN: "fixture-admin-token",
    });
    const child = new OwnedChild(process.execPath, ["dist/index.js"], { cwd: repoRoot, env, name: "foreign-200" });
    const info = await child.waitExit(d, 45000);
    const probe = await probeCandidateHealth(d, mcpPort, child.pid).catch((e) => ({ ok: false, kind: String(e.message) }));
    const stubStillThere = await fetchJsonBounded(d, `http://127.0.0.1:${mcpPort}/health`, { timeoutMs: 3000 }).then((r) => r.body?.name).catch(() => null);
    check(
      "foreign HTTP 200 rejected",
      info?.code === 1 && probe.ok === false && stubStillThere === "foreign",
      "candidate exit 1, probe not accepted, stub alive",
      JSON.stringify({ info, probeKind: probe.kind, stubStillThere })
    );
  });

  // 10. Cleanup on assertion/parse failure: throw mid-case after spawning
  //     resources; the finally-style registry cleanup must still release
  //     children, stubs, sockets and fixtures, bounded by the deadline.
  await guarded("cleanup runs after failure", 20000, async (d) => {
    const port = await allocPort();
    const stub = startStub(port, { mode: "respond", body: { status: "ok" } });
    await stub.listening;
    const child = new OwnedChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], { name: "lingerer" });
    const dir = makeFixtureDir("clc-harness-cleanup-");
    fs.writeFileSync(path.join(dir, "fixture.txt"), "x");
    // Simulate an assertion/parse failure that skips the normal path.
    const boom = await (async () => {
      try {
        const parsed = JSON.parse("this is not json");
        return parsed;
      } catch (e) {
        return e;
      }
    })();
    check("cleanup-after-failure trigger", boom instanceof Error, "parse error raised", "ok");
    const cleanupDeadline = new Deadline(10000);
    await registryCleanup(cleanupDeadline);
    check(
      "cleanup runs after failure",
      child.exitInfo !== null && !fs.existsSync(dir),
      "child stopped, fixture removed",
      JSON.stringify({ exitInfo: child.exitInfo, fixtureExists: fs.existsSync(dir) })
    );
  });

  // 11. Non-cooperative promise: the watchdog must settle the case and the
  //     suite must keep going.
  {
    const d = new Deadline(1500);
    const never = new Promise(() => {});
    let err = null;
    try {
      await boundedAwait(d, never, "never-resolving promise");
    } catch (e) {
      err = e;
    }
    check(
      "non-cooperative promise watchdog",
      err !== null && /exceeded deadline/.test(err.message),
      "watchdog rejects a never-resolving promise",
      String(err?.message)
    );
  }

  // 12. H1: HTTP status is part of health acceptance — a 500 carrying the
  //     EXPECTED pid/uuid must be rejected before any identity check.
  await guarded("HTTP 500 with matching identity rejected", 6000, async (d) => {
    const port = await allocPort();
    await startStub(port, {
      mode: "respond",
      status: 500,
      body: { status: "ok", runtime_pid: 424242, runtime_instance_id: "12345678-1234-4234-8234-123456789abc" },
    }).listening;
    const probe = await probeCandidateHealth(d, port, 424242);
    check(
      "HTTP 500 with matching identity rejected",
      probe.ok === false && probe.kind === "bad-status",
      "bad-status (identity never accepted)",
      JSON.stringify({ ok: probe.ok, kind: probe.kind })
    );
    const direct = await fetchJsonBounded(d, `http://127.0.0.1:${port}/health`, {
      timeoutMs: 3000,
      requireStatus: 200,
      predicate: () => true,
    });
    check(
      "non-200 status rejected before identity predicate",
      direct.ok === false && direct.kind === "bad-status" && direct.body === null,
      "bad-status, body not parsed",
      JSON.stringify({ ok: direct.ok, kind: direct.kind, body: direct.body })
    );
  });

  // 13. H2: registry cleanup must actually close the listening stub — the
  //     port must be rebindable afterwards.
  await guarded("stub cleanup releases listening socket", 15000, async (d) => {
    const port = await allocPort();
    const stub = startStub(port, { mode: "respond", body: { status: "ok" } });
    await stub.listening;
    await registryCleanup(d);
    const rebound = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => res.end("rebound"));
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    check(
      "stub cleanup releases listening socket",
      rebound === true,
      "port rebindable after cleanup",
      JSON.stringify({ rebound })
    );
  });

  // 14. H2: cleanup with a live pending connection — the bounded connection
  //     strategy must still release the port.
  await guarded("stub cleanup closes pending connections", 15000, async (d) => {
    const port = await allocPort();
    const stub = startStub(port, { mode: "pendingHeaders" });
    await stub.listening;
    const conn = http.request({ host: "127.0.0.1", port, path: "/health", method: "GET" });
    conn.end();
    await d.sleep(300); // let the connection reach the server and stay open
    await registryCleanup(d);
    conn.destroy();
    const rebound = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => res.end("rebound"));
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    check(
      "stub cleanup closes pending connections",
      rebound === true,
      "port rebindable with live connection",
      JSON.stringify({ rebound })
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await registryCleanup(new Deadline(10000));
  if (process.env.CLC_EVIDENCE_DIR) {
    const out = path.join(
      process.env.CLC_EVIDENCE_DIR,
      `project-memory-harness-results-${process.env.CLC_TEST_TAG || "run"}.json`
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ passed, failed, results }, null, 2));
    console.log(`results -> ${out}`);
  }
  process.exit(failed > 0 ? 1 : 0);
};

await main();
