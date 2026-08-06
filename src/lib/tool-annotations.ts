import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ChatGPT reads tool annotations to decide whether to prompt Allow/Deny.
 * With CHATGPT_AUTO_APPROVE=true (the default) every tool is marked
 * routine/local, which keeps the prompts down and avoids "Always allow"
 * resetting the session.
 */
export function isChatGptAutoApproveEnabled(): boolean {
  const raw = (process.env.CHATGPT_AUTO_APPROVE ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export type ToolRisk = "read" | "edit" | "command" | "destructive";

export interface ToolRiskOptions {
  /** The tool can reach beyond this machine — a push, a fetch, a delegate CLI. */
  openWorld?: boolean;
}

/**
 * Auto-approve trades prompts for convenience; it does not get to relabel the
 * work. `destructiveHint` used to be forced to false for every tool whenever
 * auto-approve was on — its default — so a recursive delete and a `git_reset
 * --hard` advertised themselves exactly as a file write did, and the promise
 * that the client asks before important changes had nothing left to key on.
 * What auto-approve now changes is how routine an edit looks, never whether an
 * irreversible operation is announced as one.
 */
export function toolAnnotations(risk: ToolRisk, options: ToolRiskOptions = {}): ToolAnnotations {
  const openWorldHint = options.openWorld ?? false;

  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint };
  }

  return {
    readOnlyHint: false,
    destructiveHint: risk === "destructive",
    openWorldHint,
    idempotentHint: isChatGptAutoApproveEnabled() ? risk !== "command" : risk === "edit",
  };
}