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
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { startAdminServer } from "./admin/server.js";
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

const { config } = loadConfig();

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
console.log(`[MCP] Tool profile: ${getChatGptToolProfile()} (CHATGPT_TOOL_PROFILE)`);
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
app.use(cors());
app.use(express.json({ limit: "50mb" }));
const MCP_PATHS_SET = new Set(["/", "/mcp"]);

app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);
  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError);
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
  console.log(`  Admin UI:  http://127.0.0.1:${ADMIN_PORT}/ui`);
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