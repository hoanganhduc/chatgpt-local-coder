/**
 * A tool that fails has to say so in a form a client can read.
 *
 * Tools report success as `structuredContent` — `{ ok: true, data }` — but a
 * tool that threw never reached that helper, so a refusal arrived as `isError`
 * and a bare sentence. A model keying on `ok` saw no `ok` at all, retried the
 * same denied call, and eventually reported that the connector had gone away.
 * These checks cover the envelope that fixes it and the annotations that tell a
 * client which calls are worth asking about.
 */
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clc-fail-")));
process.env.AUDIT_LOG_PATH = path.join(tmp, "audit.log");

const { applyErrorEnvelope } = await import("../dist/lib/tool-envelope.js");
const { applyHookWrapper } = await import("../dist/hooks/wrap.js");
const { toolAnnotations } = await import("../dist/lib/tool-annotations.js");
const { registerFilesystemTools } = await import("../dist/tools/filesystem.js");
const { setPermissionContext } = await import("../dist/lib/permissions.js");
const { setDefaultCwd } = await import("../dist/lib/path-security.js");

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e?.message || e}`); failed++; }

/** A stand-in for McpServer that records what each registration ends up as. */
function fakeServer() {
  const tools = new Map();
  const server = {
    registerTool: (name, config, callback) => {
      tools.set(name, { config, callback });
      return {};
    },
  };
  return {
    server,
    annotations: (name) => tools.get(name)?.config?.annotations,
    call: (name, args) => tools.get(name).callback(args, { sessionId: "s1" }),
  };
}

// --- a throwing tool leaves as structured data ---------------------------
try {
  const app = fakeServer();
  applyErrorEnvelope(app.server);
  app.server.registerTool("boom", { inputSchema: {} }, async () => {
    throw new Error("Permission denied: write outside workspace roots.");
  });

  const result = await app.call("boom", {});
  if (!result.isError) throw new Error("the failure lost its isError flag");
  if (!result.structuredContent) throw new Error("the failure carried no structuredContent");
  if (result.structuredContent.ok !== false) {
    throw new Error(`structuredContent.ok was ${result.structuredContent.ok}, not false`);
  }
  if (!String(result.structuredContent.data?.error).includes("Permission denied")) {
    throw new Error(`the reason did not survive: ${JSON.stringify(result.structuredContent.data)}`);
  }
  ok("a tool that throws returns ok:false with the reason, and still sets isError");
} catch (e) { fail("throwing tool", e); }

// --- a succeeding tool is untouched --------------------------------------
try {
  const app = fakeServer();
  applyErrorEnvelope(app.server);
  app.server.registerTool("fine", { inputSchema: {} }, async () => ({ structuredContent: { ok: true, data: { n: 1 } } }));

  const result = await app.call("fine", {});
  if (result.isError) throw new Error("a successful call was marked as an error");
  if (result.structuredContent.data.n !== 1) throw new Error("the payload was altered");
  ok("a tool that succeeds passes through unchanged");
} catch (e) { fail("succeeding tool", e); }

// --- the envelope is outermost -------------------------------------------
//
// Registration wrappers nest: whichever is applied first ends up outside. A
// throw raised by a hook rather than by the tool has to be caught too, so the
// order in server-factory is asserted here rather than assumed.
try {
  const app = fakeServer();
  applyErrorEnvelope(app.server);
  applyHookWrapper(app.server);
  app.server.registerTool("hooked", { inputSchema: {} }, async () => {
    throw new Error("thrown beneath the hook wrapper");
  });

  const result = await app.call("hooked", {});
  if (!result.structuredContent || result.structuredContent.ok !== false) {
    throw new Error("a throw from under the hook wrapper escaped the envelope");
  }
  ok("the envelope wraps the hook layer, not the other way round");
} catch (e) { fail("wrapper order", e); }

// --- a real denial, through the real tool --------------------------------
try {
  const workspace = path.join(tmp, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  setDefaultCwd(workspace);
  setPermissionContext({ profile: "workspace", roots: [workspace] });

  const app = fakeServer();
  applyErrorEnvelope(app.server);
  registerFilesystemTools(app.server);

  const result = await app.call("write_file", {
    path: path.join(tmp, "outside.txt"),
    content: "nope",
  });
  if (result.structuredContent?.ok !== false) {
    throw new Error(`a refused write came back as ${JSON.stringify(result.structuredContent ?? result)}`);
  }
  if (!/Permission denied/i.test(String(result.structuredContent.data?.error))) {
    throw new Error(`the denial did not reach the caller: ${JSON.stringify(result.structuredContent.data)}`);
  }
  if (fs.existsSync(path.join(tmp, "outside.txt"))) throw new Error("the refused write happened anyway");
  ok("a write refused by the permission engine reports ok:false to the caller");
} catch (e) { fail("refused write", e); }

// --- annotations describe the work, whatever auto-approve is set to -------
try {
  for (const setting of ["true", "false"]) {
    process.env.CHATGPT_AUTO_APPROVE = setting;
    if (toolAnnotations("destructive").destructiveHint !== true) {
      throw new Error(`destructive work was announced as routine with CHATGPT_AUTO_APPROVE=${setting}`);
    }
    if (toolAnnotations("edit").destructiveHint !== false) {
      throw new Error(`an ordinary edit was announced as destructive with CHATGPT_AUTO_APPROVE=${setting}`);
    }
    if (toolAnnotations("read").readOnlyHint !== true) throw new Error("a read lost its readOnlyHint");
  }
  delete process.env.CHATGPT_AUTO_APPROVE;
  ok("destructiveHint tracks the operation, not the auto-approve setting");

  if (toolAnnotations("command", { openWorld: true }).openWorldHint !== true) {
    throw new Error("openWorld was not carried through");
  }
  if (toolAnnotations("command").openWorldHint !== false) throw new Error("openWorld defaulted to true");
  ok("openWorldHint is opt-in per tool");
} catch (e) { fail("annotations", e); }

// --- the tools that can destroy work are the ones marked destructive ------
try {
  const workspace = path.join(tmp, "ws2");
  fs.mkdirSync(workspace, { recursive: true });
  setDefaultCwd(workspace);
  setPermissionContext({ profile: "workspace", roots: [workspace] });

  const app = fakeServer();
  registerFilesystemTools(app.server);
  const { registerGitTools } = await import("../dist/tools/git.js");
  registerGitTools(app.server, workspace);

  for (const name of ["delete_file", "delete_directory", "git_reset", "git_restore"]) {
    if (app.annotations(name)?.destructiveHint !== true) {
      throw new Error(`${name} is not announced as destructive`);
    }
  }
  for (const name of ["write_file", "edit_file", "git_add", "git_commit"]) {
    if (app.annotations(name)?.destructiveHint !== false) {
      throw new Error(`${name} is announced as destructive`);
    }
  }
  for (const name of ["git_push", "git_pull"]) {
    if (app.annotations(name)?.openWorldHint !== true) {
      throw new Error(`${name} reaches the network but is not announced as open-world`);
    }
  }
  ok("deletes and resets are marked destructive; ordinary edits are not");
} catch (e) { fail("annotated call sites", e); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
