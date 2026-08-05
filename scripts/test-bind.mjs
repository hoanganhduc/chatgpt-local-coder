/**
 * Verify the MCP listener binds loopback by default and is only reachable on a
 * non-loopback interface when the operator explicitly asks for it.
 *
 * This is the guard against a Tailscale or LAN interface silently exposing the
 * host: the server grants shell and filesystem access, so an unintended bind is
 * a remote-code-execution surface.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clc-bind-test-"));

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

/** First non-internal IPv4 address, or undefined on a loopback-only host. */
function externalIpv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

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

async function reachable(url, ms = 2500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

function startServer(env) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      CLC_CONFIG_DIR: sandbox,
      WORKSPACE_PATH: sandbox,
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

const basePort = 4600 + Math.floor(Math.random() * 100);
const lanIp = externalIpv4();

// --- default: loopback only ---------------------------------------------
{
  const port = basePort;
  const server = startServer({ PORT: String(port), ADMIN_PORT: String(port + 1) });
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`);
    ok(`default bind: reachable on 127.0.0.1:${port}`);

    if (health.permissionProfile !== "workspace") {
      fail("health profile", `health reports ${health.permissionProfile}, expected workspace`);
    } else {
      ok("health reports the active permission profile");
    }

    if (!Array.isArray(health.workspaceRoots) || health.workspaceRoots.length === 0) {
      fail("health roots", "health does not report workspaceRoots");
    } else {
      ok("health reports the workspace roots");
    }

    if (health.fullMachineAccess === true) {
      fail("health honesty", 'health still advertises fullMachineAccess: true under the workspace profile');
    } else {
      ok("health no longer claims unconditional full machine access");
    }

    if (!lanIp) {
      console.log("SKIP non-loopback reachability (no external IPv4 on this host)");
    } else if (await reachable(`http://${lanIp}:${port}/health`)) {
      fail("default bind", `server is reachable on the non-loopback address ${lanIp}:${port}`);
    } else {
      ok(`default bind: NOT reachable on ${lanIp}:${port}`);
    }
  } catch (e) {
    fail("default bind", `${e.message}\n${server.log()}`);
  } finally {
    server.child.kill();
  }
}

// --- explicit opt-in: all interfaces ------------------------------------
if (lanIp) {
  const port = basePort + 10;
  const server = startServer({
    PORT: String(port),
    ADMIN_PORT: String(port + 1),
    CLC_BIND_HOST: "0.0.0.0",
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    if (await reachable(`http://${lanIp}:${port}/health`)) {
      ok(`CLC_BIND_HOST=0.0.0.0 opts in: reachable on ${lanIp}:${port}`);
    } else {
      fail("explicit bind", `CLC_BIND_HOST=0.0.0.0 did not expose ${lanIp}:${port}`);
    }
  } catch (e) {
    fail("explicit bind", `${e.message}\n${server.log()}`);
  } finally {
    server.child.kill();
  }
} else {
  console.log("SKIP explicit bind case (no external IPv4 on this host)");
}

// --- admin server stays loopback regardless -----------------------------
if (lanIp) {
  const port = basePort + 20;
  const adminPort = port + 1;
  const server = startServer({
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
    CLC_BIND_HOST: "0.0.0.0",
  });
  try {
    await waitForHealth(`http://127.0.0.1:${adminPort}/health`);
    if (await reachable(`http://${lanIp}:${adminPort}/health`)) {
      fail("admin bind", `the admin UI is exposed on ${lanIp}:${adminPort} — it must stay loopback`);
    } else {
      ok("the admin UI stays on loopback even when the MCP listener is opened up");
    }
  } catch (e) {
    fail("admin bind", `${e.message}\n${server.log()}`);
  } finally {
    server.child.kill();
  }
}

// --- admin auth resolves a token stored in the secret store -------------
//
// The guard reads process.env.ADMIN_TOKEN. A token that lived only in
// secrets.json used to leave the admin API wide open while `doctor` reported
// ADMIN_TOKEN as set — the worst combination, since it reads as protected.
{
  const port = basePort + 30;
  const adminPort = port + 1;
  const token = "store-only-admin-token";

  fs.writeFileSync(path.join(sandbox, "secrets.json"), `${JSON.stringify({ ADMIN_TOKEN: token })}\n`, { mode: 0o600 });

  // The store must be the only source, so an inherited variable would make this
  // pass for the wrong reason.
  const inherited = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;

  const server = startServer({ PORT: String(port), ADMIN_PORT: String(adminPort) });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);

    const status = async (headers) =>
      (await fetch(`http://127.0.0.1:${adminPort}/ui/`, { headers, signal: AbortSignal.timeout(5000) })).status;

    if ((await status({})) !== 401) {
      fail("admin auth", "a request with no token was not rejected — the stored token is being ignored");
    } else {
      ok("admin auth: a stored token is enforced against an unauthenticated request");
    }

    if ((await status({ Authorization: "Bearer wrong" })) !== 401) {
      fail("admin auth", "a wrong token was accepted");
    } else {
      ok("admin auth: a wrong token is rejected");
    }

    if ((await status({ Authorization: `Bearer ${token}` })) !== 200) {
      fail("admin auth", "the stored token was not accepted");
    } else {
      ok("admin auth: the stored token is accepted");
    }

    if (server.log().includes(token)) {
      fail("admin auth", "the admin token appears in the server log");
    } else {
      ok("admin auth: the token never reaches the log");
    }
  } catch (e) {
    fail("admin auth", `${e.message}\n${server.log()}`);
  } finally {
    server.child.kill();
    if (inherited !== undefined) process.env.ADMIN_TOKEN = inherited;
    fs.rmSync(path.join(sandbox, "secrets.json"), { force: true });
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
