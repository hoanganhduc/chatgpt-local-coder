/**
 * Loopback port probes shared by `up` and `tunnel connect`.
 *
 * Both commands need to know whether the host is listening before they act —
 * `up` to refuse a second instance, `tunnel connect` to avoid publishing a
 * server that has not bound its port yet. They live here rather than in either
 * command because `serve.ts` already imports `tunnel.ts`, and having the import
 * point back would close a cycle.
 */

import net from "net";

/**
 * Whether something already holds `port` on the loopback address.
 *
 * Binding it briefly rather than connecting to it: a connect probe cannot tell
 * "nothing is listening" apart from "listening but not answering yet", and the
 * question being asked here is exactly the one the server is about to put to
 * the kernel. EACCES counts as unavailable for the same reason EADDRINUSE does
 * — the caller will not get the port either way.
 */
export async function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES");
    });
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}

/**
 * Wait for the MCP server to answer `/health`, giving up early when the process
 * that was supposed to provide it is already gone.
 *
 * `isAlive` matters because the deadline is measured in tens of seconds and a
 * child that died on startup will never answer: without it, a crashed child
 * cost the full wait before anything was reported.
 */
export async function waitForServerHealth(
  port: number,
  deadlineMs = 20_000,
  isAlive: () => boolean = () => true
): Promise<boolean> {
  return waitForHealthUrl(`http://127.0.0.1:${port}/health`, deadlineMs, isAlive);
}

/** The host health endpoint corresponding to an MCP endpoint on the same origin. */
export function healthUrlForMcpUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported MCP URL protocol ${JSON.stringify(url.protocol)}`);
  }
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Wait for the host that a tunnel will actually publish, including --mcp-url overrides. */
export function waitForMcpHealth(
  mcpUrl: string,
  deadlineMs = 20_000,
  isAlive: () => boolean = () => true
): Promise<boolean> {
  return waitForHealthUrl(healthUrlForMcpUrl(mcpUrl), deadlineMs, isAlive);
}

async function waitForHealthUrl(
  healthUrl: string,
  deadlineMs: number,
  isAlive: () => boolean
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (!isAlive()) return false;
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
