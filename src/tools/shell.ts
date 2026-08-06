import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { defaultShell, detachedSpawnOptions, killProcessTree, trackChild } from "../lib/platform.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import {
  bootstrapShellSession,
  execInShellSession,
  getShellStatus,
  resetShellSession,
} from "../lib/persistent-shell.js";

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = 400_000;

function appendLog(lines: string[], decoder: StringDecoder, data: Buffer): void {
  lines.push(decoder.write(data));
  let total = lines.reduce((sum, item) => sum + item.length, 0);
  while (total > MAX_LOG_CHARS && lines.length > 1) {
    const removed = lines.shift();
    total -= removed?.length || 0;
  }
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run shell commands to verify work (tests, build, lint). Cwd persists across ChatGPT tool calls (saved to disk). Use shell_status to check cwd. Use start_process for long jobs.",
      inputSchema: {
        command: z.string(),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
      },

      annotations: toolAnnotations("command", { openWorld: true }),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory, "read") : undefined;
      const result = await execInShellSession(command, defaultCwd, timeoutSec * 1000, cwdOverride);
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: result.exit_code === 0 ? "ok" : "error",
        details: { command, exit_code: result.exit_code },
      });
      return toolResult("run_command", result, {
        ok: result.exit_code === 0,
        summary: `exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", status, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath, "read") : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
      inputSchema: { command: z.string(), working_directory: z.string().optional() },

      annotations: toolAnnotations("command", { openWorld: true }),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory, "read") : getShellStatus().cwd || defaultCwd;
      const shell = defaultShell();
      const child = spawn(shell.command, shell.args(command), {
        cwd,
        env: process.env,
        // Detached, so this shell leads a process group and `stop_process` can
        // reach the job it started rather than only the shell that leads it.
        // No-op on Windows, where the tree is walked by taskkill instead.
        ...detachedSpawnOptions(),
      });
      // Detaching is also what takes the shell out of the terminal's foreground
      // group, where a Ctrl+C used to reach it. Tracking it is the other half of
      // that trade: without it, interrupting the host would leave a background
      // job running and reparented to init.
      const untrack = trackChild(child.pid);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        id,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: [],
        stderr: [],
        exitCode: null,
        signal: null,
      };
      processes.set(id, item);
      // One decoder per stream, held for the life of the process. A background
      // job logs for as long as it runs, so it crosses far more chunk
      // boundaries than a one-shot command does, and each one that fell
      // mid-character used to leave a pair of U+FFFD in the log the caller
      // later reads back.
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      child.stdout.on("data", (d: Buffer) => appendLog(item.stdout, outDecoder, d));
      child.stderr.on("data", (d: Buffer) => appendLog(item.stderr, errDecoder, d));
      // Recorded on `exit` rather than `close`. `close` waits for the stdio
      // pipes as well, and a job that leaves something holding them would keep
      // this reporting `running` long after the process itself was gone — which
      // is not merely inaccurate here: the kernel is free to reuse a pid the
      // moment it exits, so a stop that signalled a process group on the
      // strength of a stale record would be signalling a stranger.
      //
      // Nothing is given up by reporting the finish this early. What the
      // process printed has been read to the end by the time `exit` arrives,
      // and the case where the two events do come apart is the one above — a
      // grandchild still holding the pipes, still printing, where there is no
      // later moment to wait for.
      child.on("exit", (code, signal) => {
        item.exitCode = code;
        item.signal = signal;
        untrack();
      });
      await audit({ tool: "start_process", action: "start", target: cwd, status: "ok", details: { id, command } });
      return toolResult("start_process", { id, pid: child.pid, command, cwd, started_at: item.startedAt }, {
        summary: `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const processes_list = [...processes.values()]
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.child.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: p.exitCode === null && p.signal === null,
          exit_code: p.exitCode,
          signal: p.signal,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read stdout/stderr logs for a background process.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      const data = {
        id,
        running: item.exitCode === null && item.signal === null,
        exit_code: item.exitCode,
        signal: item.signal,
        stdout: item.stdout.join("").slice(-tail_chars),
        stderr: item.stderr.join("").slice(-tail_chars),
      };
      return toolResult("process_output", data, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = processes.get(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (item.exitCode !== null || item.signal !== null) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      // The whole group, not just the shell. `npm run dev` is the shell's child
      // and the server is that child's child, so signalling the one process
      // this host started left the job running and the port held while the tool
      // reported a stop. Safe against a recycled pid because a process already
      // seen to exit returned above.
      await killProcessTree(item.child.pid ?? 0, force ? "force" : "graceful");
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: "ok", details: { id, force } });
      return toolResult("stop_process", { id, force }, { summary: `stop sent to ${id} and everything it started` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      let cleared = 0;
      for (const [id, item] of processes) {
        if (item.exitCode !== null || item.signal !== null) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}