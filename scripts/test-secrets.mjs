/**
 * Verify the private-file secret store: env wins over file, the file is
 * created with owner-only permissions, and no API returns a secret value where
 * only presence was asked for.
 */
import fs from "fs";
import os from "os";
import path from "path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clc-secrets-test-"));
process.env.CLC_CONFIG_DIR = sandbox;

const {
  secretsPath,
  getSecret,
  setSecret,
  deleteSecret,
  listSecretNames,
  secretFileReference,
  secretsFileExists,
} = await import("../dist/lib/secrets.js");

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

const SECRET = "sk-test-do-not-log-6f2b9c";

try {
  if (path.dirname(secretsPath()) !== sandbox) throw new Error("secrets file outside configDir");
  if (secretsFileExists()) throw new Error("secrets file exists before any write");
  ok("secrets file lives in configDir and does not exist until written");
} catch (e) { fail("secretsPath", e.message); }

try {
  if (await getSecret("CLC_TEST_MISSING") !== undefined) throw new Error("missing secret returned a value");
  ok("an unset secret reads as undefined");
} catch (e) { fail("missing secret", e.message); }

try {
  await setSecret("CLC_TEST_KEY", SECRET);
  if (!secretsFileExists()) throw new Error("secrets file not created");
  if (await getSecret("CLC_TEST_KEY") !== SECRET) throw new Error("round trip failed");
  ok("setSecret then getSecret round-trips");
} catch (e) { fail("round trip", e.message); }

try {
  if (process.platform === "win32") {
    // POSIX mode bits are not meaningful on Windows; the DACL is applied by
    // icacls and is checked by the doctor command instead.
    ok("file mode check skipped on Windows (DACL applied via icacls)");
  } else {
    const mode = fs.statSync(secretsPath()).mode & 0o777;
    if (mode !== 0o600) throw new Error(`mode is ${mode.toString(8)}, expected 600`);
    ok("secrets file is mode 0600 (owner read/write only)");
  }
} catch (e) { fail("file mode", e.message); }

try {
  process.env.CLC_TEST_KEY = "from-environment";
  if (await getSecret("CLC_TEST_KEY") !== "from-environment") throw new Error("env did not win over file");
  ok("an environment variable overrides the stored file value");

  delete process.env.CLC_TEST_KEY;
  if (await getSecret("CLC_TEST_KEY") !== SECRET) throw new Error("file value lost after env cleared");
  ok("the file value is still there once the env override is removed");
} catch (e) { fail("env precedence", e.message); }

try {
  process.env.CLC_TEST_ENV_ONLY = "env-value";
  const listed = await listSecretNames(["CLC_TEST_KEY", "CLC_TEST_ENV_ONLY", "CLC_TEST_UNSET"]);

  const serialized = JSON.stringify(listed);
  if (serialized.includes(SECRET) || serialized.includes("env-value")) {
    throw new Error("listSecretNames leaked a secret value");
  }
  ok("listSecretNames never returns a secret value");

  const byName = Object.fromEntries(listed.map((e) => [e.name, e]));
  if (byName.CLC_TEST_KEY.source !== "file" || !byName.CLC_TEST_KEY.set) throw new Error("file secret misreported");
  if (byName.CLC_TEST_ENV_ONLY.source !== "env" || !byName.CLC_TEST_ENV_ONLY.set) throw new Error("env secret misreported");
  if (byName.CLC_TEST_UNSET.set) throw new Error("unset secret reported as set");
  ok("listSecretNames reports set/unset and the source of each");
  delete process.env.CLC_TEST_ENV_ONLY;
} catch (e) { fail("listSecretNames", e.message); }

try {
  const ref = await secretFileReference("CLC_TEST_KEY");
  if (!ref?.startsWith("file:")) throw new Error(`reference is not a file: form: ${ref}`);
  if (ref.includes(SECRET)) throw new Error("reference embedded the secret value");

  const refPath = ref.slice("file:".length);
  if (fs.readFileSync(refPath, "utf-8") !== SECRET) throw new Error("reference file content wrong");
  if (process.platform !== "win32") {
    const mode = fs.statSync(refPath).mode & 0o777;
    if (mode !== 0o600) throw new Error(`reference file mode ${mode.toString(8)}, expected 600`);
  }
  ok("secretFileReference returns file:<path> with the value only inside the 0600 file");

  if (await secretFileReference("CLC_TEST_UNSET") !== undefined) {
    throw new Error("reference produced for an unset secret");
  }
  ok("no reference is produced for an unset secret");
} catch (e) { fail("secretFileReference", e.message); }

try {
  await deleteSecret("CLC_TEST_KEY");
  if (await getSecret("CLC_TEST_KEY") !== undefined) throw new Error("secret survived deletion");
  const raw = fs.readFileSync(secretsPath(), "utf-8");
  if (raw.includes(SECRET)) throw new Error("deleted value still present in the file");
  ok("deleteSecret removes the value from the store file");

  await deleteSecret("CLC_TEST_NEVER_EXISTED");
  ok("deleting an unset secret is a no-op rather than an error");
} catch (e) { fail("deleteSecret", e.message); }

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
