import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import type { SkillToolOptions } from "../tools/skills.js";
import type { DelegateToolOptions } from "../tools/delegate.js";
import { hasHooks, runHooks } from "../hooks/engine.js";


const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SESSION_TTL_MS = parseInt(process.env.MCP_SESSION_TTL_MS || "86400000", 10); // 24h
const SESSION_CLEANUP_INTERVAL_MS = parseInt(
  process.env.MCP_SESSION_CLEANUP_MS || "300000",
  10
); // 5m
const SESSION_DELETE_GRACE_MS = parseInt(
  process.env.MCP_SESSION_DELETE_GRACE_MS || "45000",
  10
); // keep session after DELETE so in-flight tool calls can finish

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
  /**
   * The client sent DELETE and the transport is closed, but the session entry is
   * held a little longer. A tool call that was already running finishes because
   * DELETE waits behind it in the session queue; this window covers what comes
   * after — a late retry or a duplicate POST on the same session must be turned
   * away rather than handed to a closed transport, which accepts the request and
   * never answers it.
   */
  closedByClient?: boolean;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
  skills?: SkillToolOptions;
  delegates?: DelegateToolOptions;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  touch(sessionId: string): void;
  count(): number;
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(session: McpSession, req: Request, res: Response, body?: unknown): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

/**
 * Every method the protocol names, transcribed from the schemas the SDK
 * declares in `types.js`.
 *
 * The set exists to separate two things this host used to answer identically:
 * "no session, so I cannot serve you" and "nobody implements that". Only the
 * first is a transport fault. OpenAI's connector announces itself to a new
 * tunnel with `server/discover`, which is its own extension rather than a
 * protocol method and arrives before any `initialize` — so it reached the
 * sessionless branch and left as `400 Bad Request`. A client reading a 400 sees
 * a broken server rather than one declining an optional method, and this one
 * tried twice, five seconds apart, then stopped: the tools were never
 * enumerated and the connector sat in every later chat with nothing in it.
 *
 * Membership is deliberately generous, covering the server-to-client requests
 * that never arrive at this handler. The asymmetry is the reason: calling a
 * real method unknown would answer `-32601` where a missing session was the
 * whole problem, while calling an unknown method real just leaves the 400 that
 * was already there.
 */
const MCP_METHODS = new Set([
  "completion/complete",
  "elicitation/create",
  "initialize",
  "logging/setLevel",
  "notifications/cancelled",
  "notifications/elicitation/complete",
  "notifications/initialized",
  "notifications/message",
  "notifications/progress",
  "notifications/prompts/list_changed",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/roots/list_changed",
  "notifications/tasks/status",
  "notifications/tools/list_changed",
  "ping",
  "prompts/get",
  "prompts/list",
  "resources/list",
  "resources/read",
  "resources/subscribe",
  "resources/templates/list",
  "resources/unsubscribe",
  "roots/list",
  "sampling/createMessage",
  "tasks/cancel",
  "tasks/get",
  "tasks/list",
  "tasks/result",
  "tools/call",
  "tools/list",
]);

/**
 * Whether the body names a method the protocol defines.
 *
 * A batch — a JSON-RPC array — reports true whatever it holds, so that the
 * paths below leave it exactly where it was; sorting a mixed batch into known
 * and unknown halves is not something any client here sends.
 */
function isKnownMcpMethod(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return true;
  if (Array.isArray(body)) return true;
  const method = (body as { method?: unknown }).method;
  if (typeof method !== "string") return true;
  return MCP_METHODS.has(method);
}

/**
 * Decline a method this server does not implement, as an answer rather than a
 * refusal: HTTP 200 carrying `-32601`, which is what the SDK itself replies
 * once a session exists. The two paths agreeing is the point — before this, the
 * same request was a clean `Method not found` with a session and a
 * `400 Bad Request` without one.
 */
function sendMethodNotFound(
  res: Response,
  method: string,
  requestId: string | number | null = null
): void {
  const message = `Method not found: ${method}`;
  // Recorded so the activity log names what was declined. It is logged at
  // `ok`, because the status is 200 and declining an unimplemented method is a
  // correct answer — but silence here is what let a failing connector probe go
  // unnoticed for hours.
  res.locals.mcpError = message;
  res.status(200).json({
    jsonrpc: "2.0",
    error: { code: -32601, message },
    id: requestId,
  });
}

async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId || !lastTransportErrors[sessionId]) return undefined;
  const message = lastTransportErrors[sessionId];
  delete lastTransportErrors[sessionId];
  return message;
}

function sendSessionNotFound(res: Response, requestId: string | number | null = null): void {
  const message =
    "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
  res.locals.mcpError = message;
  res.status(404).json({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: requestId,
  });
}

async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const sessions: Record<string, McpSession> = {};
  const pendingRecoveries: Record<string, McpSession> = {};
  const deleteGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function touch(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function cancelDeleteGrace(sessionId: string): void {
    const timer = deleteGraceTimers[sessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete deleteGraceTimers[sessionId];
  }

  function scheduleDeleteGrace(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    console.log(
      `[MCP] Session DELETE — held ${SESSION_DELETE_GRACE_MS / 1000}s for in-flight tool calls: ${sessionId}`
    );
    deleteGraceTimers[sessionId] = setTimeout(() => {
      delete deleteGraceTimers[sessionId];
      removeSession(sessionId, "client DELETE (grace expired)");
    }, SESSION_DELETE_GRACE_MS);
    deleteGraceTimers[sessionId].unref?.();
  }

  function removeSession(sessionId: string, reason: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (!session) return;
    getUpstreamManager().unregisterMcpServer(session.server);
    delete sessions[sessionId];
    delete lastTransportErrors[sessionId];
    sessionOpChains.delete(sessionId);
    if (hasHooks("Stop")) {
      void runHooks({ event: "Stop", sessionId }).catch(() => undefined);
    }
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
  }

  function clearPendingRecovery(sessionId: string): void {
    delete pendingRecoveries[sessionId];
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    const mcpServer = createMcpServer(
      config.workspaceRoot,
      config.shellTimeout,
      config.workspaceRoots,
      true,
      getUpstreamManager(),
      config.projectMemoryInstructions,
      config.skills,
      config.delegates
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: preferredSessionId
        ? () => preferredSessionId
        : () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        const existing = sessions[sid];
        sessions[sid] = {
          transport,
          server: mcpServer,
          lastAccessedAt: Date.now(),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        clearPendingRecovery(sid);
        console.log(`[MCP] Session initialized: ${sid}`);
        // Lifecycle hooks are advisory: nothing here can refuse a session.
        if (hasHooks("SessionStart")) {
          void runHooks({ event: "SessionStart", sessionId: sid }).catch(() => undefined);
        }
      },
      onsessionclosed: (sid) => {
        if (!sid) return;
        if (sessions[sid]) sessions[sid].closedByClient = true;
        scheduleDeleteGrace(sid);
      },
    });

    transport.onerror = (error) => {
      const sid = transport.sessionId;
      const message = error.message || String(error);
      if (sid) lastTransportErrors[sid] = message;
    };

    // Keep session alive across transient SSE disconnects; explicit DELETE cleans up.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!sid || !sessions[sid]) return;
      console.log(`[MCP] Transport closed for ${sid} (session kept for recovery)`);
    };

    await mcpServer.connect(transport);

    const sid = transport.sessionId ?? preferredSessionId ?? randomUUID();
    return (
      sessions[sid] ?? {
        transport,
        server: mcpServer,
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
      }
    );
  }

  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "codex-mcp-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `[MCP] Recovery initialize failed: HTTP ${initResult.status} for ${staleSessionId}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `[MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions[staleSessionId]);
  }

  return {
    get(sessionId: string) {
      return sessions[sessionId];
    },

    touch,

    count() {
      return Object.keys(sessions).length;
    },

    sendSessionNotFound,

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
        const activeSid = session.transport.sessionId;
        if (activeSid) touch(activeSid);
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);

      // A session the client already closed keeps its entry for a moment so a
      // running tool call can finish, but its transport will not answer anything
      // new — a POST arriving now used to be accepted and then simply never
      // replied to. Saying so lets the client open a fresh session instead of
      // waiting on one that is gone.
      if (session.closedByClient) {
        sendSessionNotFound(res, extractRequestId(body ?? req.body));
        return;
      }

      if (sid) touch(sid);
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
      };
      // GET is the one method left out of the queue. It opens the standalone SSE
      // stream and does not return until the client closes it, so queueing it
      // left every later POST on that session waiting on a stream that never
      // ends — a client that opened one could not call a single tool afterwards.
      //
      // DELETE stays in the queue. Letting it past closes the transport out from
      // under a tool call that is still running, and that call is then never
      // answered at all: the client waits for a reply that cannot arrive. Behind
      // the queue it closes the session the moment the work in front of it is
      // done, which is both prompt and safe.
      if (sid && req.method !== "GET") {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (isInitializeRequest(body)) {
        return false;
      }

      console.log(`[MCP] Attempting session recovery for stale ID: ${staleSessionId}`);

      const protocolVersion =
        (req.headers["mcp-protocol-version"] as string | undefined) ??
        DEFAULT_PROTOCOL_VERSION;
      const mcpPath = req.path || "/mcp";

      const pending = await buildSession(staleSessionId);
      pendingRecoveries[staleSessionId] = pending;

      const warmed = await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion);
      if (!warmed) {
        clearPendingRecovery(staleSessionId);
        removeSession(staleSessionId, "recovery failed");
        return false;
      }

      const recovered = sessions[staleSessionId];
      if (!recovered) {
        clearPendingRecovery(staleSessionId);
        return false;
      }

      touch(staleSessionId);
      console.log(`[MCP] Session recovered: ${staleSessionId}`);

      const headers = { ...req.headers, "mcp-session-id": staleSessionId };
      const patchedReq = Object.assign(req, { headers });
      await enqueueSessionOp(staleSessionId, async () => {
        await recovered.transport.handleRequest(patchedReq, res, body);
      });
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of Object.entries(sessions)) {
          if (now - session.lastAccessedAt > SESSION_TTL_MS) {
            void session.transport.close().catch(() => undefined);
            removeSession(sid, "TTL expired");
          }
        }
        for (const sid of Object.keys(pendingRecoveries)) {
          if (!sessions[sid]) clearPendingRecovery(sid);
        }
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest, isKnownMcpMethod, sendMethodNotFound, MCP_METHODS };