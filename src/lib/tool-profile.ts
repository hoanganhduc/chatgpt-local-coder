export type ToolProfileName = "full" | "slim";

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "run_command",
  "shell_status",
  // A background job needs the tools that end it as well as the one that starts
  // it. Slim used to offer `start_process` alone, so a model could take a port
  // and then have no way to give it back.
  "start_process",
  "process_output",
  "process_status",
  "stop_process",
  "clear_processes",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_restore",
  "agent_status",
  "project_context",
  "remember",
  "load_path_rules",
  "rewind",
  "mcp_servers",
  "skill_list",
  "skill_read",
  "skill_run",
  "agent_delegate",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  if (profile === "full") return true;
  return SLIM_CHATGPT_TOOLS.has(name);
}