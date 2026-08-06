/**
 * Verify the permission engine enforces the workspace boundary for writes,
 * cannot be escaped via "..", symlinks, or a not-yet-existing leaf, and that
 * every profile behaves as documented.
 */
import fs from "fs";
import os from "os";
import path from "path";

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clc-perm-test-")));
const workspace = path.join(sandbox, "workspace");
const outside = path.join(sandbox, "outside");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(workspace, "src", "inside.txt"), "inside", "utf-8");
fs.writeFileSync(path.join(outside, "secret.txt"), "outside", "utf-8");

const {
  setPermissionContext,
  getPermissionProfile,
  getWorkspaceRoots,
  isPathAllowed,
  requirePathAllowed,
  requireWriteAllowed,
  requireCommandAllowed,
  commandsAreSandboxed,
  describePermissionProfile,
  resolveRealPath,
} = await import("../dist/lib/permissions.js");
const { validatePath, getAllowedRoots, getFullDiskAccess, setDefaultCwd } = await import(
  "../dist/lib/path-security.js"
);

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

/** Assert that a thunk throws. */
async function denied(label, fn) {
  try {
    await fn();
  } catch {
    return true;
  }
  throw new Error(`${label} was allowed but should have been denied`);
}

setDefaultCwd(workspace);

// --- context ------------------------------------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  if (getPermissionProfile() !== "workspace") throw new Error("profile not set");
  if (getWorkspaceRoots()[0] !== path.resolve(workspace)) throw new Error("roots not set");
  if (getAllowedRoots()[0] !== path.resolve(workspace)) throw new Error("path-security disagrees about roots");
  if (getFullDiskAccess()) throw new Error("workspace profile reported as full disk access");
  if (!describePermissionProfile().includes("workspace")) throw new Error("description does not name the profile");
  ok("setPermissionContext sets the profile and roots seen by both modules");
} catch (e) { fail("context", e.message); }

// --- workspace profile: reads ------------------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  if (!isPathAllowed(path.join(workspace, "src", "inside.txt"), "read")) throw new Error("read inside denied");
  if (!isPathAllowed(path.join(outside, "secret.txt"), "read")) throw new Error("read outside denied");
  await validatePath(path.join(outside, "secret.txt"), "read");
  ok("workspace profile: reads are unrestricted, inside and outside the roots");
} catch (e) { fail("workspace reads", e.message); }

// --- workspace profile: writes -----------------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  if (!isPathAllowed(path.join(workspace, "src", "inside.txt"), "write")) throw new Error("write inside denied");
  await validatePath(path.join(workspace, "src", "inside.txt"), "write");
  ok("workspace profile: a write inside a root is allowed");

  if (isPathAllowed(path.join(outside, "secret.txt"), "write")) throw new Error("write outside allowed");
  await denied("write outside roots", () => validatePath(path.join(outside, "secret.txt"), "write"));
  ok("workspace profile: a write outside the roots is denied (acceptance gate 4)");
} catch (e) { fail("workspace writes", e.message); }

// --- the denial message is actionable -----------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  let message = "";
  try {
    requirePathAllowed(path.join(outside, "secret.txt"), "write");
  } catch (e) { message = e.message; }
  if (!message) throw new Error("no error thrown");
  for (const needle of ["workspace", workspace, "workspaceRoots"]) {
    if (!message.includes(needle)) throw new Error(`denial message omits ${needle}: ${message}`);
  }
  ok("the denial names the profile, the roots, and how to fix it");
} catch (e) { fail("denial message", e.message); }

// --- escapes ------------------------------------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });

  const traversal = path.join(workspace, "src", "..", "..", "outside", "secret.txt");
  if (isPathAllowed(traversal, "write")) throw new Error('".." traversal escaped the root');
  await denied('".." traversal', () => validatePath(traversal, "write"));
  ok('".." traversal cannot escape a workspace root');

  // A sibling directory whose name merely starts with the root name must not
  // be treated as inside it.
  const prefixSibling = `${workspace}-evil`;
  fs.mkdirSync(prefixSibling, { recursive: true });
  if (isPathAllowed(path.join(prefixSibling, "f.txt"), "write")) {
    throw new Error("a path sharing the root's name prefix was treated as inside it");
  }
  ok("a sibling directory sharing the root's name prefix is outside the root");
} catch (e) { fail("escapes", e.message); }

// --- symlink escape (the load-bearing case) ------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  const link = path.join(workspace, "escape-link");
  try {
    fs.symlinkSync(outside, link, "dir");
  } catch (e) {
    // Windows without Developer Mode cannot create symlinks unprivileged.
    if (process.platform !== "win32") throw e;
    console.log("SKIP symlink escape (cannot create symlinks on this host)");
    throw { skip: true };
  }

  const viaLink = path.join(link, "secret.txt");
  if (isPathAllowed(viaLink, "write")) throw new Error("a symlink pointing outside the root allowed a write");
  await denied("write through an escaping symlink", () => validatePath(viaLink, "write"));
  ok("a symlink inside a root that points outside it does not permit a write");

  // The same mechanism must not break a symlink that stays inside the root.
  const innerTarget = path.join(workspace, "src");
  const innerLink = path.join(workspace, "inner-link");
  fs.symlinkSync(innerTarget, innerLink, "dir");
  if (!isPathAllowed(path.join(innerLink, "inside.txt"), "write")) {
    throw new Error("a symlink that stays inside the root was denied");
  }
  ok("a symlink that stays inside the root still permits writes");
} catch (e) {
  if (!e?.skip) fail("symlink escape", e.message);
}

// --- non-existent leaf (creating a new file) ----------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  const newInside = path.join(workspace, "src", "does", "not", "exist", "yet.txt");
  if (!isPathAllowed(newInside, "write")) throw new Error("creating a new nested file inside the root was denied");
  ok("a not-yet-existing path inside a root is writable (file creation works)");

  const newOutside = path.join(outside, "does", "not", "exist", "yet.txt");
  if (isPathAllowed(newOutside, "write")) throw new Error("creating a new file outside the root was allowed");
  ok("a not-yet-existing path outside the roots is still denied");

  if (resolveRealPath(newInside) !== path.join(fs.realpathSync(path.join(workspace, "src")), "does", "not", "exist", "yet.txt")) {
    throw new Error("resolveRealPath did not re-append the non-existent tail correctly");
  }
  ok("resolveRealPath resolves the real ancestor and re-appends the missing tail");
} catch (e) { fail("non-existent leaf", e.message); }

// --- multiple roots -----------------------------------------------------
try {
  const second = path.join(sandbox, "second");
  fs.mkdirSync(second, { recursive: true });
  setPermissionContext({ profile: "workspace", roots: [workspace, second] });
  if (!isPathAllowed(path.join(second, "f.txt"), "write")) throw new Error("second root not honoured");
  if (!isPathAllowed(path.join(workspace, "f.txt"), "write")) throw new Error("first root lost");
  if (isPathAllowed(path.join(outside, "f.txt"), "write")) throw new Error("outside allowed with multiple roots");
  ok("every configured root is writable and nothing else is");
} catch (e) { fail("multiple roots", e.message); }

// --- open profile -------------------------------------------------------
try {
  setPermissionContext({ profile: "open", roots: [workspace] });
  if (!isPathAllowed(path.join(outside, "secret.txt"), "write")) throw new Error("open profile denied a write");
  await validatePath(path.join(outside, "secret.txt"), "write");
  if (!getFullDiskAccess()) throw new Error("open profile not reported as full disk access");
  requireWriteAllowed();
  requireCommandAllowed("anything");
  ok("open profile: a write outside the roots is permitted (acceptance gate 4)");
} catch (e) { fail("open profile", e.message); }

// --- readonly profile ---------------------------------------------------
try {
  setPermissionContext({ profile: "readonly", roots: [workspace] });
  if (!isPathAllowed(path.join(workspace, "src", "inside.txt"), "read")) throw new Error("readonly denied a read");
  await validatePath(path.join(workspace, "src", "inside.txt"), "read");
  ok("readonly profile: reads are allowed");

  if (isPathAllowed(path.join(workspace, "src", "inside.txt"), "write")) throw new Error("readonly allowed a write");
  await denied("write under readonly", () => validatePath(path.join(workspace, "src", "inside.txt"), "write"));
  await denied("requireWriteAllowed under readonly", async () => requireWriteAllowed());
  await denied("requireCommandAllowed under readonly", async () => requireCommandAllowed("ls"));
  ok("readonly profile: writes and commands are denied, even inside a root");
} catch (e) { fail("readonly profile", e.message); }

// --- honesty about the shell boundary -----------------------------------
try {
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  if (commandsAreSandboxed()) throw new Error("commandsAreSandboxed claims a sandbox that does not exist");
  if (!describePermissionProfile().includes("host user")) {
    throw new Error("the profile description does not disclose that commands run as the host user");
  }
  ok("the engine reports honestly that approved commands are not sandboxed");
} catch (e) { fail("shell honesty", e.message); }

// --- the host's own secrets are out of reach in every profile ------------
//
// `read_text_file` used to return the tunnel API key to whoever asked: reads
// were unconfined in all three profiles, and the key lives in a plain file. The
// caller here is the connector the key authorizes, so this is the one boundary
// no profile is allowed to widen — `open` included.
try {
  const fakeConfigDir = path.join(sandbox, "config-home");
  fs.mkdirSync(path.join(fakeConfigDir, "secret-refs"), { recursive: true });
  fs.writeFileSync(path.join(fakeConfigDir, "secrets.json"), '{"OPENAI_TUNNEL_API_KEY":"sk-live"}', "utf-8");
  process.env.CLC_CONFIG_DIR = fakeConfigDir;

  const secrets = path.join(fakeConfigDir, "secrets.json");
  const ref = path.join(fakeConfigDir, "secret-refs", "OPENAI_TUNNEL_API_KEY");

  for (const profile of ["workspace", "open", "readonly"]) {
    setPermissionContext({ profile, roots: [workspace] });
    for (const [label, target] of [["secrets.json", secrets], ["a secret-ref", ref]]) {
      if (isPathAllowed(target, "read")) throw new Error(`${profile} allowed a read of ${label}`);
      if (isPathAllowed(target, "write")) throw new Error(`${profile} allowed a write to ${label}`);
      await denied(`${profile} read of ${label}`, () => validatePath(target, "read"));
    }
  }
  ok("no profile — workspace, open or readonly — can read or write the host's own secrets");

  // The whole directory, not a list of filenames: a key added later must be
  // covered without anyone remembering to name it here.
  setPermissionContext({ profile: "open", roots: [workspace] });
  if (isPathAllowed(path.join(fakeConfigDir, "config.json"), "read")) {
    throw new Error("only the known secret filenames were protected");
  }
  ok("the whole config directory is protected, not a list of known filenames");

  let message = "";
  try { requirePathAllowed(secrets, "read"); } catch (e) { message = e.message; }
  if (!message.includes("config directory")) throw new Error(`denial does not explain itself: ${message}`);
  if (message.includes("sk-live")) throw new Error("the denial quoted the secret it was refusing to show");
  ok("the denial says why, and does not leak what it refused");

  // A path merely resembling the config directory is unaffected.
  setPermissionContext({ profile: "workspace", roots: [workspace] });
  if (!isPathAllowed(`${fakeConfigDir}-notes.txt`, "read")) {
    throw new Error("a sibling sharing the config directory's name prefix was blocked");
  }
  ok("a path sharing the config directory's name prefix is still readable");

  delete process.env.CLC_CONFIG_DIR;
} catch (e) {
  delete process.env.CLC_CONFIG_DIR;
  fail("secret shield", e.message);
}

// --- empty input --------------------------------------------------------
try {
  await denied("empty path", () => validatePath("   ", "read"));
  ok("an empty path is rejected");
} catch (e) { fail("empty path", e.message); }

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
