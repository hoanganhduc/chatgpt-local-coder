/**
 * Verify slim tool profile exposes expected tools only.
 */
import { SLIM_CHATGPT_TOOLS, shouldExposeTool } from "../dist/lib/tool-profile.js";

const ALL_KNOWN = [
  "read_text_file", "write_file", "apply_patch", "glob", "grep", "run_command",
  "git_status", "mcp_call", "delete_directory", "read_file_base64",
];

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of ["apply_patch", "glob", "remember", "load_path_rules"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  if (shouldExposeTool("delete_directory", "slim")) throw new Error("delete_directory hidden");
  ok("heavy tools hidden in slim");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");

  // Slim offered `start_process` with nothing that ends one, so a job that took
  // a port had no way to give it back within the profile it was started in.
  for (const t of ["stop_process", "process_status", "clear_processes"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`slim starts jobs but hides ${t}`);
  }
  ok("slim exposes the tools that end a background job, not only the one that starts it");
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);