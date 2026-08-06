#!/usr/bin/env node

import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  setDefaultCwd,
  getDefaultCwd,
  getFullDiskAccess,
} from "./lib/path-security.js";
import {
  setPermissionContext,
  setImportedRuleCheck,
  describePermissionProfile,
} from "./lib/permissions.js";
import { loadConfig } from "./config/load.js";
import {
  consumeSessionTransportError,
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
  isKnownMcpMethod,
  sendMethodNotFound,
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { announceAdminUrl, startAdminServer } from "./admin/server.js";
import { getSecret } from "./lib/secrets.js";
import { logMcpHttpEvent, logMcpRequest } from "./lib/activity-log.js";
import {
  buildInstructionContext,
  summarizeInstructionContext,
  type InstructionContext,
} from "./lib/instruction-context.js";
import { getChatGptToolProfile } from "./lib/tool-profile.js";
import { loadSkillRegistry } from "./skills/registry.js";
import { checkImportedRules, loadSettings } from "./settings/index.js";
import { setHookConfig } from "./hooks/engine.js";
import { registerPostEditHook } from "./lib/post-edit-hooks.js";
import { detectDelegates } from "./delegates/index.js";
import { installLogTimestamps } from "./lib/log-timestamp.js";
import { rotateServerLog } from "./services/index.js";

// Before the first line is written, so the whole boot is stamped and a log that
// survived the previous run is not appended to indefinitely.
await rotateServerLog();
installLogTimestamps();

const { config } = loadConfig();

// `toolProfile` is read straight from the environment wherever the filter runs,
// so a value that came from config.json has to be put back there before the
// first server is built. The loader has already merged file, env and flag in
// precedence order, so this writes back the answer rather than overriding one.
process.env.CHATGPT_TOOL_PROFILE = config.toolProfile;

const PORT = config.port;
const ADMIN_PORT = config.adminPort;
const SHELL_TIMEOUT = config.shellTimeoutSec;
const BIND_HOST = config.bindHost;
const SESSION_RECOVERY =
  (process.env.MCP_SESSION_RECOVERY || "true").toLowerCase() !== "false";

const workspaceRoots = config.workspaceRoots;
const workspaceRoot = workspaceRoots[0] || process.cwd();
setDefaultCwd(workspaceRoot);
setPermissionContext({ profile: config.permissionProfile, roots: workspaceRoots });

const upstreamManager = await initUpstreamManager();

// Settings are imported before skills so that skill roots contributed by
// another agent's config are part of the discovery set.
const settings = await loadSettings({
  workspaceRoots,
  sources: config.settings.sources,
  enabled: config.settings.import,
  host: { skillRoots: config.skills.roots },
});
setImportedRuleCheck(checkImportedRules);

// Hooks come from imported settings; the post-edit checks register themselves
// so everything that runs after a tool call goes through one engine.
setHookConfig({ enabled: config.hooks.enabled, matchers: settings.hooks });
if (config.hooks.enabled) registerPostEditHook();

// Discovery runs once here so instruction building and every MCP session share
// one registry rather than re-walking every root per session.
const skillRegistry = await loadSkillRegistry({
  workspaceRoots,
  extraRoots: [...settings.skillRoots, ...config.skills.roots],
  enabled: config.skills.enabled,
  disabled: config.skills.disabled,
});

const instructionContext: InstructionContext = await buildInstructionContext({
  workspaceRoot,
  workspaceRoots,
  pid: process.pid,
  adminPort: ADMIN_PORT,
  fullDiskAccess: getFullDiskAccess(),
});

if (instructionContext.projectMemory.sections.length > 0) {
  console.log(
    `[MCP] Project memory: ${instructionContext.projectMemory.sections.length} file(s) from ${workspaceRoot} (${instructionContext.projectMemory.total_bytes} bytes)`
  );
} else {
  console.log(
    `[MCP] Project memory: no CLAUDE.md/AGENTS.md at ${workspaceRoot} — set WORKSPACE_PATH to your project root`
  );
}
if (instructionContext.git.is_repo) {
  console.log(`[MCP] Git: branch ${instructionContext.git.branch}`);
}
console.log(
  `[MCP] MCP instructions: ${Math.round(instructionContext.instructionBytes / 1024)}KB (agent prompt + env + git + memory)`
);
console.log(`[MCP] Tool profile: ${getChatGptToolProfile()}`);
console.log(
  `[MCP] Skills: ${skillRegistry.skills.length} from ${skillRegistry.roots.length} root(s)` +
    (skillRegistry.shadowed.length ? `, ${skillRegistry.shadowed.length} shadowed` : "")
);
const okSources = settings.sources.filter((s) => s.ok).length;
const badSources = settings.sources.filter((s) => !s.ok);
console.log(
  `[MCP] Imported settings: ${okSources} file(s), ${settings.permissions.deny.length} deny rule(s) enforced` +
    (badSources.length ? `, ${badSources.length} unreadable` : "")
);
for (const bad of badSources) console.warn(`[MCP] Settings unreadable: ${bad.path} — ${bad.error}`);
const hookEvents = Object.entries(settings.hooks).filter(([, v]) => v.length);
console.log(
  `[MCP] Hooks: ${config.hooks.enabled ? "on" : "off"}` +
    (hookEvents.length ? `, imported ${hookEvents.map(([e, v]) => `${e}×${v.length}`).join(" ")}` : "")
);
// PATH lookup only — the `--version` probe is deferred to first use so startup
// never waits on four agent CLIs.
const delegates = detectDelegates(config.delegates.order).filter((d) => d.available);
console.log(
  `[MCP] Delegates: ${config.delegates.enabled ? delegates.map((d) => d.id).join(", ") || "none installed" : "disabled"}`
);

const sessionManager = createSessionManager({
  workspaceRoot,
  shellTimeout: SHELL_TIMEOUT,
  workspaceRoots,
  port: PORT,
  projectMemoryInstructions: instructionContext.instructionsText,
  skills: {
    allowExecution: config.skills.allowExecution,
    maxRuntimeSec: config.skills.maxRuntimeSec,
  },
  delegates: {
    enabled: config.delegates.enabled,
    order: config.delegates.order,
    timeoutSec: config.delegates.timeoutSec,
  },
});

const app = express();

// No browser origin is allowed by default. This listener answers `run_command`,
// so a page the user happens to have open must not be able to call it: `cors()`
// with no arguments returned `Access-Control-Allow-Origin: *`, which let any
// site preflight successfully and then read the output of a command it had run
// on this machine. Denying the preflight is what stops it — the tunnel client
// and every other non-browser caller are unaffected, since CORS is enforced by
// browsers alone. Set CLC_ALLOWED_ORIGINS if you genuinely drive this host from
// a web page.
const allowedOrigins = (process.env.CLC_ALLOWED_ORIGINS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false }));
if (allowedOrigins.length > 0) {
  console.log(`[MCP] Browser origins allowed: ${allowedOrigins.join(", ")}`);
}
app.use(express.json({ limit: "50mb" }));
const MCP_PATHS_SET = new Set(["/", "/mcp"]);

app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);

  // A failed tool call is an HTTP 200 carrying `isError` in the body, so the
  // status code alone cannot tell a refusal from a success — every denied write
  // used to be recorded as ok, which made the audit log agree with a model that
  // had reported work it never did. The reply is watched rather than parsed: it
  // arrives either as one JSON object or as a run of SSE frames, and only the
  // flag matters.
  //
  // The quote must be unescaped. The protocol's own flag is written plainly,
  // while the same text inside a tool's output — reading a file that happens to
  // contain it — is JSON-escaped to `\"isError\":true`, so the lookbehind is
  // what keeps a file's contents from being read as a verdict on the call.
  const NEEDLE = /(?<!\\)"isError"\s*:\s*true/;
  let toolFailed = false;
  if (req.method === "POST" && isMcpRoute) {
    // Carried across chunks so a boundary falling inside the token cannot hide
    // it. Appended to, not replaced: a short write would otherwise drop the part
    // of the token the previous chunk was holding.
    let tail = "";
    const watch = (chunk: unknown): void => {
      if (toolFailed || chunk === undefined || typeof chunk === "function") return;
      // The SDK's replies reach `res.write` as plain Uint8Array views, not Node
      // Buffers — they come off a Web ReadableStream — so testing for a Buffer
      // matched nothing and this check silently never fired.
      const text =
        typeof chunk === "string"
          ? chunk
          : ArrayBuffer.isView(chunk)
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf-8")
            : "";
      if (!text) return;
      const window = tail + text;
      if (NEEDLE.test(window)) toolFailed = true;
      tail = window.slice(-24);
    };
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      watch(chunk);
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk: unknown, ...rest: unknown[]) => {
      watch(chunk);
      return (end as (...a: unknown[]) => unknown)(chunk, ...rest);
    }) as typeof res.end;
  }

  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError, toolFailed);
      return;
    }

    if (isMcpRoute && res.statusCode >= 400) {
      const reason =
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined) ||
        (res.statusCode === 404
          ? "Session not found"
          : res.statusCode === 400
            ? "Bad Request (missing Mcp-Session-Id or invalid state)"
            : `HTTP ${res.statusCode}`);
      logMcpHttpEvent({
        method: req.method,
        path: req.path,
        httpStatus: res.statusCode,
        durationMs: duration,
        sessionId,
        errorMessage: reason,
      });
      return;
    }

    if (!isMcpRoute) {
      console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms${sessionInfo}`);
    }
  });
  next();
});

// ChatGPT co the goi "/" hoac "/mcp" — ho tro ca hai
const MCP_PATHS = ["/", "/mcp"];

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "codex-mcp-server",
    workspace: workspaceRoot,
    defaultCwd: getDefaultCwd(),
    permissionProfile: config.permissionProfile,
    workspaceRoots,
    fullDiskAccess: getFullDiskAccess(),
    activeSessions: sessionManager.count(),
    sessionRecovery: SESSION_RECOVERY,
    mcpEndpoints: MCP_PATHS,
    instructions: summarizeInstructionContext(instructionContext),
  });
});

async function handleMcpPost(req: express.Request, res: express.Response): Promise<void> {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const requestId = extractRequestId(req.body);

    const existing = sessionId ? sessionManager.get(sessionId) : undefined;
    if (existing) {
      await sessionManager.handleExisting(existing, req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (sessionId) {
        console.log(`[MCP] Re-initialize with stale session header: ${sessionId}`);
      }
      await sessionManager.createNew(req, res, req.body);
      return;
    }

    // Answered before the session is considered, because a method nobody
    // implements is not a session problem. With a session the SDK already
    // replies `-32601` to exactly this, so the sessionless path now agrees with
    // it instead of returning a 400 that reads as a broken server.
    if (!isKnownMcpMethod(req.body)) {
      sendMethodNotFound(res, String((req.body as { method?: unknown })?.method), requestId);
      return;
    }

    if (sessionId) {
      if (SESSION_RECOVERY) {
        const recovered = await sessionManager.tryRecoverStale(
          sessionId,
          req,
          res,
          req.body
        );
        if (recovered) return;
      }
      sessionManager.sendSessionNotFound(res, requestId);
      return;
    }

    sessionManager.sendBadRequest(
      res,
      "Bad Request: Mcp-Session-Id header is required",
      requestId
    );
  } catch (error) {
    console.log("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

function handleStaleSession(
  req: express.Request,
  res: express.Response,
  sessionId: string | undefined
): boolean {
  if (!sessionId || sessionManager.get(sessionId)) {
    return false;
  }
  sessionManager.sendSessionNotFound(res);
  return true;
}

async function handleMcpGet(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

async function handleMcpDelete(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

for (const mcpPath of MCP_PATHS) {
  app.post(mcpPath, handleMcpPost);
  app.get(mcpPath, handleMcpGet);
  app.delete(mcpPath, handleMcpDelete);
}

sessionManager.startCleanup();

// The admin guard reads process.env.ADMIN_TOKEN, so a token that lives only in
// the secret store would leave the admin API unauthenticated while `doctor`
// reported the token as set. Hydrate it here, before the admin server starts.
// An exported variable still wins, matching getSecret's own precedence.
if (!process.env.ADMIN_TOKEN) {
  const storedAdminToken = await getSecret("ADMIN_TOKEN");
  if (storedAdminToken) process.env.ADMIN_TOKEN = storedAdminToken;
}

const adminServer = startAdminServer({
  port: ADMIN_PORT,
  host: "127.0.0.1",
  mcpPort: PORT,
  pid: process.pid,
  manager: upstreamManager,
  sessionCount: () => sessionManager.count(),
  instructionSummary: () => summarizeInstructionContext(instructionContext),
  instructionsPreview: () => instructionContext.instructionsText,
});

// Bind loopback by default so the listener is not reachable over the LAN or a
// Tailscale interface. Override with CLC_BIND_HOST only when that is intended.
const server = app.listen(PORT, BIND_HOST, () => {
  const display = BIND_HOST === "0.0.0.0" || BIND_HOST === "::" ? "localhost" : BIND_HOST;
  console.log("");
  console.log("========================================");
  console.log("  chatgpt-local-coder");
  console.log("========================================");
  console.log(`  Local:     http://${display}:${PORT}`);
  console.log(`  MCP:       http://${display}:${PORT}/`);
  console.log(`  MCP alt:   http://${display}:${PORT}/mcp`);
  console.log(`  Health:    http://${display}:${PORT}/health`);
  // The URL the admin server would answer, token and all. Printing a bare
  // /ui here would name an address that answers 401. Off a terminal this
  // prints the path to the file holding it rather than the token itself.
  console.log(`  Admin UI:  ${announceAdminUrl("127.0.0.1", ADMIN_PORT)}`);
  console.log(`  Bind host: ${BIND_HOST}`);
  console.log(`  Default cwd: ${workspaceRoot}`);
  console.log(`  Permissions: ${describePermissionProfile()}`);
  console.log(`  Session recovery: ${SESSION_RECOVERY ? "ON" : "OFF"}`);
  console.log(`  PID:       ${process.pid}`);
  console.log("========================================");
  console.log("  Running... (Ctrl+C to stop)");
  console.log("========================================");
  console.log("");
});

// A tool call is a request that can legitimately produce nothing for minutes —
// a test suite, an install, a delegate CLI. Node's defaults are written for web
// traffic: it advertises `Keep-Alive: timeout=5` and abandons any request that
// takes longer than five minutes, so a long build was dropped by the host that
// started it. These are raised to sit beyond the longest call a tool can make.
const IDLE_KEEPALIVE_MS = 65_000;
server.keepAliveTimeout = IDLE_KEEPALIVE_MS;
// Must exceed keepAliveTimeout, or Node races itself and closes mid-header.
server.headersTimeout = IDLE_KEEPALIVE_MS + 5_000;
// A shell command is already bounded by shellTimeoutSec; a second, shorter
// deadline here would cut off calls the tool itself considers still running.
server.requestTimeout = Math.max(SHELL_TIMEOUT * 1000 + 60_000, 600_000);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[ERROR] Port ${PORT} is already in use.`);
    console.error("Find the process that holds it:");
    console.error(
      process.platform === "win32"
        ? `  netstat -ano | findstr ":${PORT}"`
        : `  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`
    );
    console.error("Then stop it, or start with a different PORT.\n");
  } else {
    console.error("\n[ERROR] Server failed to start:", err.message, "\n");
  }
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\n[DUNG] Server dang tat...");
  sessionManager.stopCleanup();
  void upstreamManager.shutdown();
  adminServer.close();
  server.close(() => process.exit(0));
});

// Tranh process tu tat khi stdin dong (Windows + .bat)
if (process.stdin.isTTY) {
  process.stdin.resume();
}