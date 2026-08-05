export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
2. Call project_context(path) only for a different repo than WORKSPACE_PATH.
3. Explore with glob (file names) and grep (content), then read_text_file.
4. Edit with apply_patch (preferred), multi_edit, or write_file for new files.
5. Run builds/tests with run_command (short) or start_process + process_output (long).
6. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
Tools marked † exist only under the \`full\` tool profile. Calling one under the
default \`slim\` profile returns \`Tool not found\` — that is the profile, not a
server fault. \`tools/list\` is the authoritative list.

- glob / grep / read_text_file: explore (offset+limit for partial reads)
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- create_directory† / delete_directory† / copy_file† / move_file† / delete_file† — under slim, use run_command
- run_command: persistent shell (cd persists); shell_status / shell_reset†
- git_status / git_diff / git_add / git_commit / git_restore / git_branch† / git_stash†
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- mcp_servers / mcp_tools† / mcp_call† — delegate to upstream MCP servers on this machine
- git_push† / git_checkout† / delete_directory†: may be blocked by ChatGPT safety — use run_command fallback

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Absolute paths, or relative to the default cwd. Path comparison is
case-sensitive on Linux and case-insensitive on Windows and macOS. What you are
allowed to reach is stated in the header — call agent_status if a write is
denied rather than looking for a way around it.
`.trim();

/**
 * Describe the access the profile actually grants.
 *
 * This used to be hardcoded to "Full machine access: ON" regardless of the
 * profile, which told every model it could write anywhere while the default
 * `workspace` profile denied writes outside the roots. A model that believes it
 * has access it does not have wastes turns on calls the server refuses.
 */
function describeAccess(fullDiskAccess: boolean, workspaceRoots: string[]): string {
  if (fullDiskAccess) {
    return "Machine access: full — reads and writes are allowed anywhere on this machine.";
  }
  return [
    "Machine access: scoped — reads are unrestricted, writes are allowed only inside",
    `the workspace roots (${workspaceRoots.join("; ")}). A write outside them is denied by design.`,
  ].join("\n");
}

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    describeAccess(fullDiskAccess, workspaceRoots),
    // Scoping applies to the file tools only. Saying so here keeps a model from
    // reading the line above as a sandbox guarantee it is not.
    "Approved shell commands run with full host-user privileges; the profile scopes file tools, not a subshell.",
    "Tag this connector in ChatGPT before every task.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load CLAUDE.md from another repo",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}