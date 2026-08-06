/**
 * Who is allowed to reach the two listeners, proven against real ones.
 *
 * Both holes this covers were reachable from a page the user merely had open.
 * The MCP listener answered `cors()` with no arguments, so it returned
 * `Access-Control-Allow-Origin: *` — any site could preflight, open a session
 * and read back the output of a command it had run on this machine. The admin
 * API waved every request through whenever ADMIN_TOKEN was unset, which is its
 * normal state, and `/api/config/env` returns the contents of the `.env` file.
 *
 * Asserted through HTTP rather than by unit-testing the middleware: what
 * matters is the header on the wire and the status a caller actually gets.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clc-http-")));
const workspace = path.join(sandbox, "workspace");
fs.mkdirSync(workspace, { recursive: true });

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e?.message || e}`); failed++; }

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

function startServer(env) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      CLC_CONFIG_DIR: path.join(sandbox, "config"),
      CLC_STATE_DIR: path.join(sandbox, "state"),
      WORKSPACE_PATH: workspace,
      MCP_SESSION_RECOVERY: "false",
      ADMIN_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  return { child, log: () => log };
}

const EVIL = "https://evil.example";
const port = 4900 + Math.floor(Math.random() * 90);
const adminPort = port + 1;

// --- default: no browser origin is allowed anywhere ----------------------
{
  const server = startServer({ PORT: String(port), ADMIN_PORT: String(adminPort) });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);

    // The preflight is the gate. A JSON POST is not a simple request, so a
    // browser will not send the real call unless this one approves it.
    const preflight = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: EVIL,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const allowOrigin = preflight.headers.get("access-control-allow-origin");
    if (allowOrigin) {
      throw new Error(`the preflight approved ${EVIL} with Access-Control-Allow-Origin: ${allowOrigin}`);
    }
    ok("a foreign origin's preflight to /mcp is not approved");

    const posted = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: EVIL,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    if (posted.headers.get("access-control-allow-origin")) {
      throw new Error("the reply told the browser a foreign origin could read it");
    }
    ok("a reply to a foreign origin carries no Access-Control-Allow-Origin, so a browser cannot read it");

    // The tunnel client sends no Origin at all. It must be unaffected — CORS is
    // a browser rule, and breaking non-browser callers would break the product.
    const plain = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    if (!plain.ok || !plain.headers.get("mcp-session-id")) {
      throw new Error(`a client sending no Origin was refused: HTTP ${plain.status}`);
    }
    ok("a caller that sends no Origin — the tunnel client — still opens a session");

    // --- admin API ------------------------------------------------------
    const health = await fetch(`http://127.0.0.1:${adminPort}/health`);
    if (!health.ok) throw new Error(`the liveness probe needs a token: HTTP ${health.status}`);
    ok("the admin liveness probe stays open, so status and doctor keep working");

    const env = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`);
    if (env.status !== 401) throw new Error(`/api/config/env answered HTTP ${env.status} with no token`);
    ok("the admin API refuses an unauthenticated caller even with ADMIN_TOKEN unset");

    const write = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { INJECTED: "1" } }),
    });
    if (write.status !== 401) throw new Error(`a config write answered HTTP ${write.status} with no token`);
    ok("an unauthenticated caller cannot write the .env file either");

    // The page is what drives the API, so serving it to an unauthenticated
    // caller would mean handing out the credential for the routes behind it:
    // anything on this machine could ask for the UI, keep the cookie, and be
    // admin. Asking for the page must not be how you get the token.
    const bareUi = await fetch(`http://127.0.0.1:${adminPort}/ui/`);
    if (bareUi.status !== 401) throw new Error(`the admin UI answered HTTP ${bareUi.status} with no token`);
    const bareCookie = bareUi.headers.get("set-cookie");
    if (bareCookie && bareCookie.includes("clc_admin=")) {
      throw new Error("an unauthenticated request was given a token cookie");
    }
    ok("the admin UI does not hand its token to an unauthenticated caller");

    // A generated token is a secret and stdout is not private: run as a service,
    // the banner goes to the journal. Off a terminal the URL has to reach the
    // operator some other way, and the token must not be in the log at all.
    const urlFile = path.join(sandbox, "state", "admin-url");
    if (!fs.existsSync(urlFile)) {
      throw new Error(`no admin URL file was written:\n${server.log().slice(-500)}`);
    }
    const printed = fs.readFileSync(urlFile, "utf-8").match(/\/ui\/\?token=([a-f0-9]{64})/);
    if (!printed) throw new Error(`the admin URL file holds no usable URL: ${fs.readFileSync(urlFile, "utf-8")}`);
    const token = printed[1];

    if (server.log().includes(token)) {
      throw new Error("the generated admin token was printed to the log");
    }
    ok("the generated admin token is not written to the log");

    if (process.platform !== "win32") {
      const mode = fs.statSync(urlFile).mode & 0o777;
      if (mode !== 0o600) throw new Error(`the admin URL file is mode ${mode.toString(8)}, not 600`);
      ok("the file holding it is readable only by its owner");
    }

    const opened = await fetch(`http://127.0.0.1:${adminPort}/ui/?token=${token}`, { redirect: "manual" });
    const cookie = opened.headers.get("set-cookie");
    if (opened.status >= 400) throw new Error(`the printed admin URL was refused: HTTP ${opened.status}`);
    if (!cookie || !cookie.includes("clc_admin=")) throw new Error("opening the printed URL issued no cookie");
    if (!/SameSite=Strict/i.test(cookie)) {
      throw new Error(`the cookie is not SameSite=Strict, so another site could ride it: ${cookie}`);
    }
    ok("the URL printed at startup opens the UI and issues a SameSite=Strict cookie");

    const withCookie = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    if (!withCookie.ok) throw new Error(`the cookie from the printed URL was rejected: HTTP ${withCookie.status}`);
    ok("that cookie authenticates the page for the API");

    const wrongQuery = await fetch(`http://127.0.0.1:${adminPort}/ui/?token=nope`, { redirect: "manual" });
    if (wrongQuery.status !== 401) throw new Error(`a wrong ?token answered HTTP ${wrongQuery.status}`);
    if (wrongQuery.headers.get("set-cookie")?.includes("clc_admin=")) {
      throw new Error("a wrong ?token was still given a cookie");
    }
    ok("a wrong ?token is refused and issues nothing");

    const wrongToken = await fetch(`http://127.0.0.1:${adminPort}/api/config/env`, {
      headers: { Authorization: "Bearer not-the-token" },
    });
    if (wrongToken.status !== 401) throw new Error(`a wrong token answered HTTP ${wrongToken.status}`);
    ok("a wrong token is refused");
  } catch (e) {
    fail("default access rules", e);
    console.error(server.log().slice(-2000));
  } finally {
    server.child.kill("SIGKILL");
  }
}

// --- an operator who does drive this from a browser can say so -----------
{
  const p = port + 10;
  const server = startServer({
    PORT: String(p),
    ADMIN_PORT: String(p + 1),
    CLC_ALLOWED_ORIGINS: `${EVIL},http://localhost:5173`,
  });
  try {
    await waitForHealth(`http://127.0.0.1:${p}/health`);
    const preflight = await fetch(`http://127.0.0.1:${p}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    if (preflight.headers.get("access-control-allow-origin") !== "http://localhost:5173") {
      throw new Error("a listed origin was not allowed");
    }
    ok("an origin named in CLC_ALLOWED_ORIGINS is allowed");

    const other = await fetch(`http://127.0.0.1:${p}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://not-listed.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    if (other.headers.get("access-control-allow-origin")) {
      throw new Error("naming one origin allowed all of them");
    }
    ok("naming an origin does not admit the rest");
  } catch (e) {
    fail("allowlisted origins", e);
    console.error(server.log().slice(-2000));
  } finally {
    server.child.kill("SIGKILL");
  }
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
