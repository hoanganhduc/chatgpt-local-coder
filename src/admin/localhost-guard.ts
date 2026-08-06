import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

function isLocalAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  // IPv4-mapped and unspecified bind addresses when connecting locally
  if (normalized === "0.0.0.0" || normalized === "::") return true;
  return false;
}

export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress;
  if (!isLocalAddress(remote)) {
    res.status(403).json({ ok: false, error: "Admin API is localhost-only" });
    return;
  }
  next();
}

export const ADMIN_COOKIE = "clc_admin";

/**
 * A generated token when the operator has not set one, so the API is never open.
 *
 * `adminAuth` used to wave every request through whenever ADMIN_TOKEN was unset
 * — its normal state — which made `/api/config/env`, a route that returns the
 * contents of the `.env` file and writes it back, reachable by anything able to
 * make an HTTP request to this port. Falling back to a per-boot random token
 * closes that without asking the user to invent one: a generated token is
 * printed as a ready-to-open URL at startup, so the browser path costs one
 * click and every other caller still has to present something.
 */
let generated: string | undefined;

export function adminToken(): string {
  const configured = process.env.ADMIN_TOKEN?.trim();
  if (configured) return configured;
  if (!generated) generated = crypto.randomBytes(32).toString("hex");
  return generated;
}

/** True when the token is one this process invented rather than one that was set. */
export function adminTokenIsGenerated(): boolean {
  return !process.env.ADMIN_TOKEN?.trim();
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Timing-safe compare that does not leak the token's length through an early return. */
function matches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The `?token=` on a navigation, which is the only credential a browser address bar can carry. */
function queryToken(req: Request): string | undefined {
  const value = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof value === "string" ? value : undefined;
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const fromQuery = queryToken(req);
  const provided =
    (header?.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-admin-token"] as string | undefined)) ??
    fromQuery ??
    readCookie(req.headers.cookie, ADMIN_COOKIE);

  if (!matches(provided, adminToken())) {
    res.status(401).json({
      ok: false,
      error: adminTokenIsGenerated()
        ? "Admin token required. Open the admin UI using the URL printed at startup, or set ADMIN_TOKEN and send it as a Bearer token."
        : "Invalid admin token",
    });
    return;
  }

  // A token that arrived in the URL is exchanged for a cookie, so the page's own
  // fetches carry it and the token stops travelling in the address bar. The
  // cookie is only ever set for a request that already proved it had the token:
  // handing one to an unauthenticated caller would make the token decorative,
  // since anything on this machine could ask for a valid one and be given it.
  //
  // SameSite=Strict is what makes it safe to accept: a request another site
  // causes the browser to make carries no cookie, so the UI authenticates
  // without opening a cross-site path to the same routes.
  if (fromQuery && provided === fromQuery) {
    res.cookie(ADMIN_COOKIE, adminToken(), { httpOnly: true, sameSite: "strict", path: "/" });
    if (req.method === "GET") {
      const [pathname] = req.originalUrl.split("?");
      res.redirect(pathname);
      return;
    }
  }

  next();
}
