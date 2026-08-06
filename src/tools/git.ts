import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { runGit, type GitRunResult } from "../lib/git-run.js";
import { requireWriteAllowed, type PathIntent } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

async function gitOrThrow(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await runGit(args, cwd);
  // Reported as its own failure rather than as a git that ran and disagreed:
  // there is nothing about the repository to fix.
  if (result.not_found) throw new Error("git not found. Install Git for Windows.");
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited with code ${result.exit_code}`);
  }
  return result;
}

export function registerGitTools(server: McpServer, defaultCwd: string): void {
  const repo = async (p: string | undefined, intent: PathIntent) =>
    p ? validatePath(p, intent) : defaultCwd;

  server.registerTool("git_status", {
    title: "Git Status", description: "Show git working tree status.",
    inputSchema: { path: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath }) => {
    const cwd = await repo(repoPath, "read");
    const r = await gitOrThrow(["status", "--short", "--branch"], cwd);
    await audit({ tool: "git_status", action: "git", target: cwd, status: "ok" });
    return toolResult("git_status", { path: cwd, output: r.stdout || "Clean working tree" });
  });

  server.registerTool("git_diff", {
    title: "Git Diff", description: "Show unstaged or staged changes.",
    inputSchema: { path: z.string().optional(), staged: z.boolean().optional().default(false), file: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, staged, file }) => {
    const cwd = await repo(repoPath, "read");
    const args = ["diff"];
    if (staged) args.push("--staged");
    if (file) args.push("--", file);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_diff", { path: cwd, staged, file, output: r.stdout || "No changes" });
  });

  server.registerTool("git_log", {
    title: "Git Log", description: "Show recent commit history.",
    inputSchema: { path: z.string().optional(), count: z.number().optional().default(10) },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, count }) => {
    const cwd = await repo(repoPath, "read");
    const r = await gitOrThrow(["log", "--oneline", "-n", String(count)], cwd);
    return toolResult("git_log", { path: cwd, count, commits: r.stdout.split("\n").filter(Boolean) });
  });

  server.registerTool("git_add", {
    title: "Git Add", description: "Stage files for commit.",
    inputSchema: { path: z.string().optional(), files: z.array(z.string()).optional(), all: z.boolean().optional().default(true) },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, all }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    const args = ["add"];
    if (all && (!files || files.length === 0)) args.push("-A");
    else if (files?.length) args.push(...files);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_add", { path: cwd, files: files || ["-A"], output: r.stdout });
  });

  server.registerTool("git_commit", {
    title: "Git Commit", description: "Create a commit (stages all first unless stage_only=false).",
    inputSchema: {
      message: z.string(),
      path: z.string().optional(),
      stage_all: z.boolean().optional().default(true),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ message, path: repoPath, stage_all }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    if (stage_all) await gitOrThrow(["add", "-A"], cwd);
    const r = await gitOrThrow(["commit", "-m", message], cwd);
    await audit({ tool: "git_commit", action: "git", target: cwd, status: "ok", details: { message } });
    return toolResult("git_commit", { path: cwd, message, output: r.stdout });
  });

  server.registerTool("git_branch", {
    title: "Git Branch", description: "List/create/switch branches.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "create", "switch", "create-and-switch"]).optional().default("list"),
      name: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, name }) => {
    const cwd = await repo(repoPath, action === "list" ? "read" : "write");
    let args: string[];
    if (action === "list") args = ["branch", "--all"];
    else {
      requireWriteAllowed();
      if (!name) throw new Error("name is required");
      args = action === "create" ? ["branch", name] : action === "switch" ? ["switch", name] : ["switch", "-c", name];
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_branch", { path: cwd, action, name, output: r.stdout });
  });

  server.registerTool("git_checkout", {
    title: "Switch Git Branch",
    description:
      "Switch the current local repository to an existing branch. Local workspace only — does not modify remotes.",
    inputSchema: {
      path: z.string().optional(),
      branch: z.string().describe("Existing branch name to switch to"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, branch }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    const r = await gitOrThrow(["switch", branch], cwd);
    return toolResult("git_checkout", {
      path: cwd,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: `git switch ${branch}`,
    });
  });

  server.registerTool("git_restore", {
    title: "Restore Tracked Files",
    description:
      "Restore tracked file(s) in the current repo to the last committed version. Local workspace only.",
    inputSchema: {
      path: z.string().optional(),
      files: z.array(z.string()).min(1).describe("Repo-relative file paths to restore"),
      source: z
        .string()
        .optional()
        .default("HEAD")
        .describe("Revision to restore from (default HEAD)"),
    },

    annotations: toolAnnotations("destructive"),
  }, async ({ path: repoPath, files, source }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    let r: GitRunResult;
    const restore = await runGit(["restore", "--source", source, "--", ...files], cwd);
    if (restore.exit_code === 0) {
      r = restore;
    } else {
      r = await gitOrThrow(["checkout", source, "--", ...files], cwd);
    }
    return toolResult("git_restore", {
      path: cwd,
      files,
      source,
      output: r.stdout || r.stderr || "Restored",
      run_command_fallback: `git restore --source ${source} -- ${files.join(" ")}`,
    });
  });

  server.registerTool("git_push", {
    title: "Sync Commits to Remote",
    description:
      "Upload local commits to the repository's configured remote (default origin). Uses the repo's existing remote URL.",
    inputSchema: {
      path: z.string().optional(),
      remote: z.string().optional().default("origin"),
      branch: z.string().optional(),
      set_upstream: z.boolean().optional().default(false),
    },

    annotations: toolAnnotations("edit", { openWorld: true }),
  }, async ({ path: repoPath, remote, branch, set_upstream }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    const args = ["push"];
    if (set_upstream) args.push("-u");
    args.push(remote);
    if (branch) args.push(branch);
    const r = await gitOrThrow(args, cwd);
    const cmd = ["git push", set_upstream ? "-u" : "", remote, branch ?? ""]
      .filter(Boolean)
      .join(" ");
    return toolResult("git_push", {
      path: cwd,
      remote,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: cmd,
    });
  });

  server.registerTool("git_pull", {
    title: "Sync from Remote",
    description:
      "Download updates from the repository's configured remote into the local working copy.",
    inputSchema: { path: z.string().optional(), remote: z.string().optional().default("origin"), branch: z.string().optional() },

    annotations: toolAnnotations("edit", { openWorld: true }),
  }, async ({ path: repoPath, remote, branch }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    const args = ["pull", remote];
    if (branch) args.push(branch);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_pull", { path: cwd, remote, branch, output: r.stdout || r.stderr });
  });

  server.registerTool("git_stash", {
    title: "Git Stash", description: "Stash list/push/pop/apply.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "push", "pop", "apply"]).optional().default("list"),
      message: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, message }) => {
    const cwd = await repo(repoPath, action === "list" ? "read" : "write");
    const args = ["stash"];
    if (action === "list") args.push("list");
    else {
      requireWriteAllowed();
      if (action === "push") {
        args.push("push");
        if (message) args.push("-m", message);
      } else args.push(action);
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_stash", { path: cwd, action, output: r.stdout || r.stderr });
  });

  server.registerTool("git_reset", {
    title: "Git Reset",
    description:
      "Move HEAD to a ref in the local repo. mixed=unstage commits, soft=keep staged, hard=discard working changes.",
    inputSchema: {
      path: z.string().optional(),
      mode: z.enum(["soft", "mixed", "hard"]).optional().default("mixed"),
      ref: z.string().optional().default("HEAD"),
    },

    annotations: toolAnnotations("destructive"),
  }, async ({ path: repoPath, mode, ref }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath, "write");
    const r = await gitOrThrow(["reset", `--${mode}`, ref], cwd);
    return toolResult("git_reset", { path: cwd, mode, ref, output: r.stdout || r.stderr });
  });
}