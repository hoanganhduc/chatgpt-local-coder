import os from "os";
import { runGit } from "./git-run.js";

/**
 * How long the snapshot waits on git. Far shorter than a git tool call is
 * allowed: this runs while a session is starting, and context that says nothing
 * is better than context that arrives two minutes late.
 */
const SNAPSHOT_TIMEOUT_MS = 15_000;

const snapshotGit = (args: string[], cwd: string) => runGit(args, cwd, { timeoutMs: SNAPSHOT_TIMEOUT_MS });

export interface GitSnapshot {
  is_repo: boolean;
  branch?: string;
  status_short?: string;
  recent_commits?: string[];
  error?: string;
}

export async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const root = await snapshotGit(["rev-parse", "--show-toplevel"], cwd);
  if (root.exit_code !== 0) {
    return { is_repo: false, error: root.not_found ? "git not found" : root.stderr || "not a git repository" };
  }

  const [branch, status, log] = await Promise.all([
    snapshotGit(["branch", "--show-current"], cwd),
    snapshotGit(["status", "--short", "--branch"], cwd),
    snapshotGit(["log", "-3", "--oneline", "--no-decorate"], cwd),
  ]);

  return {
    is_repo: true,
    branch: branch.stdout || "(detached)",
    status_short: status.stdout.slice(0, 1200),
    recent_commits: log.stdout ? log.stdout.split("\n").filter(Boolean) : [],
  };
}

export function formatGitSnapshotForInstructions(snapshot: GitSnapshot): string {
  if (!snapshot.is_repo) {
    return "## Git\nNot a git repository at WORKSPACE_PATH (or git unavailable).";
  }

  const lines = [
    "## Git (auto-loaded like Claude Code)",
    `Branch: ${snapshot.branch}`,
    "Status:",
    snapshot.status_short || "(clean)",
  ];
  if (snapshot.recent_commits?.length) {
    lines.push("Recent commits:", ...snapshot.recent_commits.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

export function formatEnvironmentForInstructions(opts: {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
  nodeVersion: string;
}): string {
  return [
    "## Environment",
    `Platform: ${process.platform} ${os.release()} (${os.arch()})`,
    `Node: ${opts.nodeVersion}`,
    `MCP PID: ${opts.pid}`,
    `Default cwd (WORKSPACE_PATH): ${opts.workspaceRoot}`,
    `Admin UI: http://127.0.0.1:${opts.adminPort}/ui`,
    opts.workspaceRoots.length > 1
      ? `Additional workspace roots:\n${opts.workspaceRoots.slice(1).map((r) => `- ${r}`).join("\n")}`
      : "",
    "Relative paths resolve from default cwd. Use absolute paths when working outside it.",
  ]
    .filter(Boolean)
    .join("\n");
}