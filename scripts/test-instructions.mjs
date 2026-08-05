/**
 * Verify that the instructions handed to a connecting model describe the access
 * the profile actually grants.
 *
 * This regressed twice at once: buildServerInstructions ignored its
 * fullDiskAccess parameter, and its caller passed a hardcoded `true`. Every
 * session was told "Full machine access: ON" while the default workspace
 * profile denied writes outside the roots, so a model spent turns on calls the
 * server was always going to refuse.
 */
import { buildServerInstructions, MCP_QUICKSTART } from "../dist/lib/quickstart.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    failed++;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const ROOTS = ["/home/u/project", "/home/u/other"];

check("a scoped profile is described as scoped, and names the roots", () => {
  const text = buildServerInstructions("/home/u/project", ROOTS, false);
  assert(/Machine access: scoped/.test(text), "scoped access not stated");
  assert(!/Machine access: full/.test(text), "claimed full access under a scoped profile");
  assert(!/Full machine access: ON/.test(text), "the old unconditional claim is back");
  for (const root of ROOTS) {
    assert(text.includes(root), `root ${root} missing from the instructions`);
  }
});

check("an open profile is described as full", () => {
  const text = buildServerInstructions("/home/u/project", ROOTS, true);
  assert(/Machine access: full/.test(text), "full access not stated");
  assert(!/Machine access: scoped/.test(text), "claimed scoped access under an open profile");
});

// Scoping applies to the file tools. A model that reads the access line as a
// sandbox guarantee would draw the wrong conclusion about run_command.
check("the shell caveat travels with the access statement", () => {
  for (const fullDiskAccess of [true, false]) {
    const text = buildServerInstructions("/home/u/project", ROOTS, fullDiskAccess);
    assert(/full host-user privileges/.test(text), `shell caveat missing (fullDiskAccess=${fullDiskAccess})`);
  }
});

check("the context block is preserved between header and footer", () => {
  const text = buildServerInstructions("/home/u/project", ROOTS, false, "CONTEXT-MARKER");
  assert(text.includes("CONTEXT-MARKER"), "context block dropped");
  assert(
    text.indexOf("Machine access") < text.indexOf("CONTEXT-MARKER"),
    "context block is not after the header"
  );
  assert(
    text.indexOf("CONTEXT-MARKER") < text.indexOf("Quick pointers"),
    "context block is not before the footer"
  );
});

// The default profile exposes 27 of 53 tools. The cheat sheet lists all of
// them, so a model needs to know which calls will come back `Tool not found`.
check("the cheat sheet marks full-only tools and explains the marker", () => {
  assert(/Tool not found/.test(MCP_QUICKSTART), "no explanation of what a missing tool means");
  for (const tool of ["delete_file", "mcp_call", "git_push", "shell_reset"]) {
    assert(new RegExp(`${tool}†`).test(MCP_QUICKSTART), `${tool} is full-only but not marked`);
  }
  for (const tool of ["run_command", "git_commit", "apply_patch"]) {
    assert(!new RegExp(`${tool}†`).test(MCP_QUICKSTART), `${tool} is in slim but marked full-only`);
  }
});

check("the cheat sheet no longer asserts access it cannot know", () => {
  assert(!/Full machine access/.test(MCP_QUICKSTART), "static text claims full machine access");
  assert(!/C:\\\\/.test(MCP_QUICKSTART), "Windows drive letters offered as the path example");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
