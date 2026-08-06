import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { createAdminRouter } from "./routes.js";
import { adminAuth, adminToken, adminTokenIsGenerated, localhostOnly } from "./localhost-guard.js";
import { stateDir } from "../config/paths.js";
import { writeRestricted } from "../lib/secrets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AdminServerOptions {
  host?: string;
  port: number;
  mcpPort: number;
  pid: number;
  manager: McpUpstreamManager;
  sessionCount: () => number;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}

/**
 * The URL that actually opens the admin UI.
 *
 * A token this process invented is included, because it is the only way the
 * operator can reach their own UI. A token the operator configured is theirs and
 * is never echoed.
 */
export function adminUiUrl(host: string, port: number): string {
  const base = `http://${host}:${port}/ui`;
  return adminTokenIsGenerated() ? `${base}/?token=${adminToken()}` : base;
}

/** Where the ready-to-open URL is left when it cannot be shown on a terminal. */
export function adminUrlFile(): string {
  return path.join(stateDir(), "admin-url");
}

/**
 * The banner's admin line, and the file behind it when printing would leak.
 *
 * A generated token is a secret, and stdout is not private: run under systemd or
 * launchd, the banner goes to the journal, which is retained and readable by
 * more than the person who started the process. So the URL is printed only to an
 * attached terminal — the operator who ran it and is looking at it. Otherwise it
 * goes to a file only its owner can read, and the banner names the path.
 *
 * A configured token is never printed either way; the bare `/ui` is enough,
 * because whoever set ADMIN_TOKEN already has it.
 */
export function announceAdminUrl(host: string, port: number): string {
  const url = adminUiUrl(host, port);
  if (!adminTokenIsGenerated()) return url;
  if (process.stdout.isTTY) return url;

  const target = adminUrlFile();
  void writeRestricted(target, `${url}\n`).catch(() => undefined);
  return `${target} (open the URL in this file — it holds this run's token)`;
}

export function startAdminServer(options: AdminServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnly);

  // `/` is the one route ahead of the check, and only to point a bare
  // navigation at the UI. The query is carried across so an opened startup link
  // still authenticates.
  app.get("/", (req, res) => {
    const query = req.originalUrl.slice(req.originalUrl.indexOf("?"));
    res.redirect(req.originalUrl.includes("?") ? `/ui/${query}` : "/ui/");
  });

  // Applied to the UI as well as the API: the page and its script are what
  // drive those routes, so leaving them open would mean handing the token to
  // whoever asked for the page. Scoped rather than global because `/health` is
  // a liveness probe with nothing behind it, and `clc status`, `doctor` and the
  // test suite all read it without a token.
  const uiDir = path.resolve(__dirname, "../../public/ui");
  app.use("/ui", adminAuth, express.static(uiDir));
  app.use("/api", adminAuth);
  app.use(createAdminRouter(options.manager, {
    mcpPort: options.mcpPort,
    pid: options.pid,
    sessionCount: options.sessionCount,
    instructionSummary: options.instructionSummary,
    instructionsPreview: options.instructionsPreview,
  }));

  return app.listen(options.port, host, () => {
    console.log(`  Admin UI:  ${announceAdminUrl(host, options.port)}`);
    if (adminTokenIsGenerated()) {
      console.log(`             (this run only — set ADMIN_TOKEN to keep one across restarts)`);
    }
    console.log(`  Admin API: http://${host}:${options.port}/health`);
  });
}