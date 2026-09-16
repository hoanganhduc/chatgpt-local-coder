/**
 * Shared test harness for server-level checks (REV-R04).
 *
 * - `Deadline` is a monotonic deadline: every request and every body read only
 *   uses the remaining time, and cancellation is driven by AbortSignal so a
 *   peer that never sends headers, never ends a body, or sends garbage cannot
 *   hang the suite.
 * - `OwnedChild` registers exit/error listeners synchronously at spawn, so a
 *   child that exits before any caller awaits it is never lost; stop/waitExit
 *   are bounded and never assume a future exit event still exists.
 * - Ports are allocated independently (never port+1) and health is accepted
 *   only when the instance identity matches — a foreign HTTP 200 is a failure.
 * - Every resource (children, stubs, sockets, timers, fixtures) is registered
 *   in the cleanup registry; cleanup is deadline-bounded and ownership-based.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class Deadline {
  /** @param {number} totalMs */
  constructor(totalMs) {
    this.startMs = performance.now();
    this.totalMs = totalMs;
    this.controller = new AbortController();
    this.expired = false;
    this.timer = setTimeout(() => {
      this.expired = true;
      this.controller.abort();
    }, totalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
  remainingMs() {
    return Math.max(0, this.totalMs - (performance.now() - this.startMs));
  }
  /** Per-request signal: bounded by both the given budget and the deadline. */
  signal(perRequestMs) {
    return AbortSignal.timeout(Math.min(perRequestMs, Math.max(1, this.remainingMs())));
  }
  /** Cancellable sleep honoring the deadline. */
  async sleep(ms) {
    if (this.remainingMs() <= 0) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, Math.min(ms, this.remainingMs()));
      this.controller.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
  dispose() {
    clearTimeout(this.timer);
  }
}

/**
 * Bounded JSON fetch. Covers: no response headers, HTTP 200 with a body that
 * never ends, invalid JSON, and a response from the wrong instance (optional
 * `predicate`). The HTTP status is part of acceptance: a non-success status
 * is rejected BEFORE the identity predicate runs (a 500 carrying the right
 * PID/UUID is still a failure). `requireStatus` accepts a number (exact
 * match, used for /health) or `"2xx"` (default: any success status).
 * On deadline/timeout the promise always settles.
 */
export async function fetchJsonBounded(deadline, url, { timeoutMs = 5000, predicate, requireStatus = "2xx" } = {}) {
  const signal = deadline.signal(timeoutMs);
  let response;
  try {
    response = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`no response headers from ${url} within deadline/timeout`);
    }
    throw err;
  }
  const statusOk =
    requireStatus === "2xx" ? response.status >= 200 && response.status < 300 : response.status === requireStatus;
  if (!statusOk) {
    return {
      ok: false,
      kind: "bad-status",
      status: response.status,
      body: null,
    };
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`response body from ${url} never ended within deadline/timeout`);
    }
    throw err;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 80)}`);
  }
  if (predicate && !predicate(body)) {
    return { ok: false, kind: "wrong-instance", status: response.status, body };
  }
  return { ok: true, kind: "ok", status: response.status, body };
}

/** Never-hanging await for promises that may not cooperate with cancellation. */
export function boundedAwait(deadline, promise, label = "operation") {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`${label} exceeded deadline (non-cooperative)`)),
      deadline.remainingMs()
    );
    promise.then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e)
    );
  });
}

const registry = {
  items: [],
  add(fn) {
    this.items.push(fn);
  },
  async cleanup(deadline) {
    const items = this.items.splice(0).reverse();
    for (const fn of items) {
      try {
        await boundedAwait(deadline, fn(deadline), "cleanup step");
      } catch {
        /* a failed cleanup step must not stop the remaining ones */
      }
    }
  },
  size() {
    return this.items.length;
  },
};

export function registryCleanup(deadline) {
  return registry.cleanup(deadline);
}
export function registrySize() {
  return registry.size();
}

/**
 * Owned child process. Listeners are attached synchronously right after spawn
 * (exit-before-listener safe); stop/waitExit are deadline-bounded; a child that
 * already exited resolves immediately.
 */
export class OwnedChild {
  constructor(command, args, { cwd, env, name = "child" } = {}) {
    this.name = name;
    this.exitInfo = null;
    this.spawnError = null;
    this.output = "";
    this._exitWaiters = [];
    this.process = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    this.process.on("error", (err) => {
      this.spawnError = err;
      const waiters = this._exitWaiters.splice(0);
      for (const fn of waiters) fn({ code: "spawn-error", signal: null });
    });
    this.process.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      const waiters = this._exitWaiters.splice(0);
      for (const fn of waiters) fn(this.exitInfo);
    });
    this.process.stdout?.on("data", (d) => {
      this.output += d;
    });
    this.process.stderr?.on("data", (d) => {
      this.output += d;
    });
    registry.add(async (deadline) => {
      if (this.exitInfo) return;
      await this.stop(deadline);
    });
  }
  waitExit(deadline, capMs = 30000) {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    if (this.spawnError) return Promise.resolve({ code: "spawn-error", signal: null });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ code: "deadline", signal: null }),
        Math.min(capMs, Math.max(1, deadline.remainingMs()))
      );
      this._exitWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }
  async stop(deadline) {
    if (this.exitInfo) return this.exitInfo;
    if (this.spawnError) return { code: "spawn-error", signal: null };
    try {
      this.process.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const info = await this.waitExit(deadline);
    if (!this.exitInfo) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      return this.waitExit(new Deadline(5000));
    }
    return info;
  }
  get pid() {
    return this.process.pid;
  }
}

/** Allocate a free loopback port. Probing is only a hint: every consumer must
 *  verify bind/identity afterwards (see verifyCandidateHealth). */
export function allocPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Two independent, distinct ports; never port+1 by construction. */
export async function allocPortPair() {
  const a = await allocPort();
  let b = await allocPort();
  while (b === a || b === a + 1 || b === a - 1) b = await allocPort();
  return { mcpPort: a, adminPort: b };
}

/**
 * Health probe that accepts only the intended instance: status 200 AND the
 * exact expected PID AND a fresh UUID. Anything else (including a foreign
 * HTTP 200 from another server on the port) is a wrong-instance result.
 * Polls within the deadline while the server boots; every attempt is bounded
 * by the deadline (no headers / unending body / bad JSON all settle).
 */
export async function probeCandidateHealth(deadline, port, expectedPid) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  let lastFailure = "no response";
  while (deadline.remainingMs() > 0) {
    try {
      const result = await fetchJsonBounded(deadline, `http://127.0.0.1:${port}/health`, {
        timeoutMs: 3000,
        requireStatus: 200, // health acceptance requires the exact status, not just a parseable body
        predicate: (body) =>
          body?.runtime_pid === expectedPid && uuidPattern.test(body?.runtime_instance_id ?? ""),
      });
      if (result.ok) return result;
      lastFailure = result.kind;
      return result; // foreign 200 / wrong identity: fail fast, do not retry
    } catch (err) {
      lastFailure = String(err.message);
      await deadline.sleep(200);
    }
  }
  return { ok: false, kind: `no-health-within-deadline:${lastFailure}`, body: null };
}

/**
 * Owned stub HTTP server for fault injection. Modes:
 *  - status + body: reply with JSON
 *  - pendingHeaders: accept the connection, never send anything
 *  - pendingBody: send 200 + Content-Length, then stop writing
 */
export function startStub(port, { mode = "respond", status = 200, body = {}, rawText } = {}) {
  const srv = http.createServer((req, res) => {
    if (mode === "pendingHeaders") {
      return; // never respond
    }
    if (mode === "pendingBody") {
      res.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
      res.write('{"partial":');
      return; // never finish
    }
    res.writeHead(status, { "content-type": rawText ? "text/plain" : "application/json" });
    res.end(rawText ?? JSON.stringify(body));
  });
  const state = { listening: false, closed: false, closing: false };
  const sockets = new Set();
  srv.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const listening = new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      state.listening = true;
      resolve();
    });
  });
  /** Close the currently listening server, exactly once, with a bounded
   *  strategy for active/pending connections: after a short grace period any
   *  connection still open is destroyed so the port is actually released. */
  const closeServer = () =>
    new Promise((resolve) => {
      if (state.closed || state.closing) {
        state.closing = true;
        const wait = setInterval(() => {
          if (state.closed) {
            clearInterval(wait);
            resolve();
          }
        }, 25);
        wait.unref?.();
        setTimeout(resolve, 3000).unref?.(); // hard bound if close never reports
        return;
      }
      state.closing = true;
      try {
        srv.close(() => {
          state.closed = true;
          resolve();
        });
      } catch {
        state.closed = true;
        resolve();
      }
      const grace = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 500);
      grace.unref?.();
      setTimeout(() => {
        if (!state.closed) {
          state.closed = true; // a server that ignores close: destroy every connection
          for (const socket of sockets) socket.destroy();
        }
        resolve();
      }, 3000).unref?.();
    });
  registry.add(async (deadline) => {
    if (state.closed) return; // idempotent
    if (!state.listening) return; // listen never succeeded: nothing owns the socket
    await boundedAwait(deadline, closeServer(), "stub close");
  });
  return {
    server: srv,
    listening,
    async close() {
      await closeServer();
    },
  };
}

/** Register a fixture directory for removal at cleanup. */
export function registerFixtureDir(dir) {
  registry.add(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function makeFixtureDir(prefix = "clc-harness-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerFixtureDir(dir);
  return dir;
}

/**
 * Fully-constructed environment for a chatgpt-local-coder server child:
 * synthetic home/config/state/cache/log, loopback profile, imports/delegates/
 * hooks/skill-execution off, no production variables inherited (PATH is the
 * only inherited value, for toolchain lookup).
 */
export function buildClcServerEnv(base, home, workspace, overrides = {}) {
  const env = {
    PATH: process.env.PATH || "",
    HOME: home,
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_STATE_HOME: path.join(base, "xdg-state"),
    XDG_CACHE_HOME: path.join(base, "xdg-cache"),
    CLC_CONFIG_DIR: path.join(base, "clc-config"),
    CLC_STATE_DIR: path.join(base, "clc-state", "chatgpt-local-coder"),
    CLC_CACHE_DIR: path.join(base, "clc-cache", "chatgpt-local-coder"),
    MCP_SHELL_STATE_DIR: path.join(base, "shell-state"),
    CODEX_HOME: path.join(base, "codex"),
    CHECKPOINT_PATH: path.join(base, "checkpoints"),
    AUDIT_LOG_PATH: path.join(base, "logs", "audit.jsonl"),
    MCP_UPSTREAM_CONFIG: path.join(base, "upstream.json"),
    TMPDIR: path.join(base, "tmp"),
    TMP: path.join(base, "tmp"),
    TEMP: path.join(base, "tmp"),
    CLC_PERMISSION_PROFILE: "workspace",
    CLC_SETTINGS_IMPORT: "false",
    CLC_DELEGATES: "false",
    CLC_HOOKS: "false",
    CLC_SKILL_EXECUTION: "false",
    CHATGPT_TOOL_PROFILE: "slim",
    WORKSPACE_PATH: workspace,
    ...(process.platform === "win32"
      ? {
          USERPROFILE: home,
          APPDATA: path.join(home, "appdata", "roaming"),
          LOCALAPPDATA: path.join(home, "appdata", "local"),
        }
      : {}),
    ...overrides,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  fs.mkdirSync(path.dirname(env.AUDIT_LOG_PATH), { recursive: true });
  fs.writeFileSync(env.MCP_UPSTREAM_CONFIG, '{"version":1,"servers":[]}');
  return env;
}
