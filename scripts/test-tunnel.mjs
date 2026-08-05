/**
 * Tunnel manager (T10): argv construction, the reference-only key rule, the
 * unhealthy path, asset selection for the running platform, and the zip reader
 * that unpacks a downloaded release.
 *
 * A stub stands in for `tunnel-client`. It is a Node module loaded through
 * `NODE_OPTIONS=--require`, which is the one form of fake executable that works
 * identically on Windows, macOS and Linux: a shebang script cannot be spawned
 * on Windows, and Node refuses to spawn a `.cmd` without a shell.
 *
 * `runtimes connect` starts a supervised background process for real, so no
 * assertion here ever points at the real binary.
 */
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
function check(name, fn) {
  try { fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message || e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function throws(fn, pattern, what) {
  try { fn(); } catch (e) {
    assert(pattern.test(e.message), `${what}: unexpected message ${e.message}`);
    return e;
  }
  throw new Error(`${what}: expected a throw`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-tunnel-"));

// Point the cache and config directories at the sandbox before anything is
// imported: this machine may already hold a real tunnel-client download.
process.env.CLC_CONFIG_DIR = path.join(tmp, "config");
process.env.CLC_CACHE_DIR = path.join(tmp, "cache");
process.env.CLC_STATE_DIR = path.join(tmp, "state");

const {
  CHECKSUM_ASSET,
  compareVersions,
  parseChecksums,
  resolveTunnelBinary,
  selectAsset,
  sha256,
  tunnelAssetName,
  tunnelBinaryName,
  tunnelCacheDir,
} = await import("../dist/tunnel/release.js");
const {
  assertKeyReference,
  buildConnectArgs,
  buildCreateArgs,
  buildRemoveArgs,
  buildStatusArgs,
  buildStopArgs,
  defaultProfileDir,
  tunnelConnect,
  tunnelCreate,
  tunnelStatus,
} = await import("../dist/tunnel/runtime.js");
const { extractZip, readZipEntries } = await import("../dist/tunnel/unzip.js");
const { platformId, archId, exeSuffix } = await import("../dist/lib/platform.js");

// --------------------------------------------------------------- argv shape

check("create builds the documented argv", () => {
  assert(
    JSON.stringify(buildCreateArgs({ alias: "host" })) ===
      JSON.stringify(["runtimes", "create", "--alias", "host", "--json"]),
    `unexpected: ${buildCreateArgs({ alias: "host" }).join(" ")}`
  );
  const full = buildCreateArgs({ alias: "host", name: "Laptop", description: "desk" });
  assert(full.includes("--name") && full[full.indexOf("--name") + 1] === "Laptop", "name not passed");
  assert(full[full.length - 1] === "--json", "--json must come last");
});

// `runtimes create` is a control-plane write and needs an admin key. Without
// this the alias step of `tunnel init` could never succeed, whatever the caller
// supplied.
check("create passes an admin key reference, and only a reference", () => {
  const args = buildCreateArgs({ alias: "host", adminKey: "env:OPENAI_ADMIN_KEY" });
  assert(args.includes("--admin-key"), "admin key not passed");
  assert(args[args.indexOf("--admin-key") + 1] === "env:OPENAI_ADMIN_KEY", "wrong admin key value");
  assert(args[args.length - 1] === "--json", "--json must come last");

  const secret = "sk-admin-live-should-never-appear";
  const error = throws(
    () => buildCreateArgs({ alias: "host", adminKey: secret }),
    /only env:NAME or file:/,
    "literal admin key"
  );
  assert(!error.message.includes(secret), "the rejection echoed the key back");
});

check("connect builds the documented argv in order", () => {
  const args = buildConnectArgs({
    alias: "host",
    profile: "host",
    profileDir: "/p",
    mcpServerUrl: "http://127.0.0.1:3000/mcp",
    runtimeApiKey: "env:OPENAI_TUNNEL_API_KEY",
  });
  assert(
    JSON.stringify(args) ===
      JSON.stringify([
        "runtimes", "connect",
        "--alias", "host",
        "--profile", "host",
        "--profile-dir", "/p",
        "--mcp-server-url", "http://127.0.0.1:3000/mcp",
        "--runtime-api-key", "env:OPENAI_TUNNEL_API_KEY",
        "--json",
      ]),
    `unexpected: ${args.join(" ")}`
  );
});

check("connect appends the optional tunnel id and admin key before --json", () => {
  const args = buildConnectArgs({
    alias: "host",
    profile: "p",
    profileDir: "/p",
    mcpServerUrl: "http://127.0.0.1:3000/mcp",
    runtimeApiKey: "file:/tmp/key",
    tunnelId: "tun_123",
    adminKey: "env:ADMIN_TOKEN",
  });
  assert(args[args.indexOf("--tunnel-id") + 1] === "tun_123", "tunnel id not passed");
  assert(args[args.indexOf("--admin-key") + 1] === "env:ADMIN_TOKEN", "admin key not passed");
  assert(args[args.length - 1] === "--json", "--json must come last");
});

check("status, stop and rm take the alias positionally", () => {
  assert(JSON.stringify(buildStatusArgs("h")) === JSON.stringify(["runtimes", "status", "h", "--json"]), "status");
  assert(JSON.stringify(buildStopArgs("h")) === JSON.stringify(["runtimes", "stop", "h", "--json"]), "stop");
  assert(JSON.stringify(buildRemoveArgs("h")) === JSON.stringify(["runtimes", "rm", "h", "--json"]), "rm");
});

// -------------------------------------------------------- reference-only keys

check("only env: and file: references are accepted as keys", () => {
  assertKeyReference("env:OPENAI_TUNNEL_API_KEY", "--runtime-api-key");
  assertKeyReference("file:/home/u/.config/key", "--runtime-api-key");
  assertKeyReference("file:C:\\Users\\u\\key", "--runtime-api-key");
  throws(() => assertKeyReference("env:9bad", "--runtime-api-key"), /only env:NAME or file:/, "malformed env name");
  throws(() => assertKeyReference("sk-live-abc", "--runtime-api-key"), /only env:NAME or file:/, "literal key");
});

check("rejecting a literal key does not echo the key", () => {
  const secret = "sk-live-do-not-print-me";
  const error = throws(() => assertKeyReference(secret, "--runtime-api-key"), /only env:NAME/, "literal key");
  assert(!error.message.includes(secret), `the message leaked the key: ${error.message}`);
  assert(error.message.includes("--runtime-api-key"), "the message should name the flag");
});

check("connect refuses to build argv around literal key material", () => {
  const base = { alias: "h", profile: "p", profileDir: "/p", mcpServerUrl: "http://127.0.0.1:3000/mcp" };
  throws(
    () => buildConnectArgs({ ...base, runtimeApiKey: "sk-live-abc" }),
    /--runtime-api-key accepts only/,
    "literal runtime key"
  );
  throws(
    () => buildConnectArgs({ ...base, runtimeApiKey: "env:K", adminKey: "sk-admin-abc" }),
    /--admin-key accepts only/,
    "literal admin key"
  );
});

// ------------------------------------------------------------------ the stub

const stubDir = path.join(tmp, "stub");
await fs.mkdir(stubDir, { recursive: true });
const stubPath = path.join(stubDir, "tunnel-client-stub.cjs");
const stubLog = path.join(stubDir, "argv.jsonl");
const runtimeLog = path.join(stubDir, "runtime.log");

await fs.writeFile(
  stubPath,
  `const fs = require("fs");
const path = require("path");
// Node rewrites argv[1] into an absolute path. The first tunnel argument is
// always the literal word \`runtimes\`, so its basename recovers it exactly.
const argv = [path.basename(process.argv[1]), ...process.argv.slice(2)];
fs.appendFileSync(process.env.CLC_STUB_LOG, JSON.stringify(argv) + "\\n");

const mode = process.env.CLC_STUB_MODE || "healthy";
const healthy = mode === "healthy";
const sub = argv[1];
const body = { alias: argv.includes("--alias") ? argv[argv.indexOf("--alias") + 1] : argv[2] };

if (sub === "connect" || sub === "status") {
  body.healthy = healthy;
  body.state = healthy ? "running" : "starting";
  body.health_url = "http://127.0.0.1:9999/health";
  body.config_path = path.join(process.env.CLC_STUB_DIR, "runtime-config.json");
  if (!healthy) body.launch_diagnostics = { log_path: process.env.CLC_STUB_LOGFILE };
}

if (mode === "fail") {
  process.stderr.write("stub: connect refused\\n");
  console.log(JSON.stringify(body));
  process.exit(3);
}
console.log(JSON.stringify(body));
process.exit(0);
`,
  "utf-8"
);

await fs.writeFile(runtimeLog, ["boot: starting", "warn: upstream unreachable", "error: boom"].join("\n"), "utf-8");

const secretValue = "sk-live-SUPER-SECRET-KEY";
const secretFile = path.join(stubDir, "runtime.key");
await fs.writeFile(secretFile, secretValue, "utf-8");

/**
 * `--require <path>` as NODE_OPTIONS will read it back.
 *
 * Node does not hand NODE_OPTIONS to a shell; it tokenises the string itself,
 * and inside a quoted run a backslash escapes the next character. A Windows
 * path quoted as-is therefore arrives with every separator eaten —
 * `C:\Users\RUNNER~1\...` resolves as `C:UsersRUNNER~1...` and the preload
 * fails with MODULE_NOT_FOUND. The quotes still have to be there for a path
 * containing a space, so the backslashes are doubled rather than dropped. On
 * POSIX there are none and this is a no-op.
 */
function requireOption(modulePath) {
  return `--require "${modulePath.replace(/\\/g, "\\\\")}"`;
}

// Asserted on every OS: a Linux or macOS run otherwise cannot see that the
// preload path is malformed, and every stub-backed test below silently stops
// testing anything the moment it is.
check("a Windows stub path survives NODE_OPTIONS tokenising", () => {
  const option = requireOption("C:\\Users\\RUNNER~1\\AppData\\stub.cjs");
  // Undo what Node's tokeniser does inside a quoted run: drop the quotes, then
  // let each backslash escape the character after it.
  const unquoted = option.slice('--require "'.length, -1).replace(/\\(.)/g, "$1");
  assert(unquoted === "C:\\Users\\RUNNER~1\\AppData\\stub.cjs", `Node would preload ${unquoted}`);
});

/** Run one stub-backed call with a clean argv log. */
async function withStub(mode, fn) {
  await fs.writeFile(stubLog, "", "utf-8");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${saved ? `${saved} ` : ""}${requireOption(stubPath)}`;
  process.env.CLC_STUB_LOG = stubLog;
  process.env.CLC_STUB_DIR = stubDir;
  process.env.CLC_STUB_LOGFILE = runtimeLog;
  process.env.CLC_STUB_MODE = mode;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
}

async function recordedArgv() {
  const text = await fs.readFile(stubLog, "utf-8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// `binary` is the Node executable; the stub is what actually answers.
const stubOpts = { binary: process.execPath, timeoutMs: 20_000 };

await checkAsync("the stub receives the exact create argv", async () => {
  const result = await withStub("healthy", () => tunnelCreate(stubOpts, { alias: "acceptance" }));
  assert(result.ok, `create failed: ${result.stderr}`);
  const [argv] = await recordedArgv();
  assert(
    JSON.stringify(argv) === JSON.stringify(["runtimes", "create", "--alias", "acceptance", "--json"]),
    `unexpected argv: ${argv.join(" ")}`
  );
  assert(result.json?.alias === "acceptance", "the JSON body was not parsed");
});

await checkAsync("a healthy runtime reports its health url and reads no log", async () => {
  const result = await withStub("healthy", () =>
    tunnelConnect(
      stubOpts,
      {
        alias: "acceptance",
        profile: "acceptance",
        profileDir: path.join(tmp, "profiles"),
        mcpServerUrl: "http://127.0.0.1:3000/mcp",
        runtimeApiKey: `file:${secretFile}`,
      },
      1500
    )
  );
  assert(result.healthy === true, "should be healthy");
  assert(result.healthUrl === "http://127.0.0.1:9999/health", `health url: ${result.healthUrl}`);
  assert(result.configPath?.endsWith("runtime-config.json"), `config path: ${result.configPath}`);
  assert(result.logTail === undefined, "a healthy runtime should not have its log read");
});

await checkAsync("only the key reference reaches the child's argv", async () => {
  const argvs = await recordedArgv();
  const flat = argvs.flat();
  assert(flat.includes(`file:${secretFile}`), "the file: reference should be passed");
  assert(
    !flat.some((a) => a.includes(secretValue)),
    "the literal key must never appear in an argument"
  );
});

await checkAsync("an unhealthy runtime surfaces the log tail after the deadline", async () => {
  const started = Date.now();
  const result = await withStub("unhealthy", () =>
    tunnelConnect(
      stubOpts,
      {
        alias: "acceptance",
        profile: "acceptance",
        profileDir: path.join(tmp, "profiles"),
        mcpServerUrl: "http://127.0.0.1:3000/mcp",
        runtimeApiKey: "env:OPENAI_TUNNEL_API_KEY",
      },
      1500
    )
  );
  assert(result.healthy === false, "should not be healthy");
  assert(result.logPath === runtimeLog, `log path: ${result.logPath}`);
  assert(result.logTail?.includes("error: boom"), `log tail: ${result.logTail}`);
  assert(Date.now() - started >= 1000, "it should have polled at least once before giving up");

  const argvs = await recordedArgv();
  assert(argvs[0][1] === "connect", "the first call should be connect");
  assert(
    argvs.slice(1).every((a) => a[1] === "status"),
    "everything after connect should be a status poll"
  );
});

await checkAsync("a failed connect returns the log tail without polling", async () => {
  const result = await withStub("fail", () =>
    tunnelConnect(
      stubOpts,
      {
        alias: "acceptance",
        profile: "acceptance",
        profileDir: path.join(tmp, "profiles"),
        mcpServerUrl: "http://127.0.0.1:3000/mcp",
        runtimeApiKey: "env:OPENAI_TUNNEL_API_KEY",
      },
      1500
    )
  );
  assert(result.ok === false, "connect exited non-zero, so ok must be false");
  assert(result.healthy === false, "should not be healthy");
  assert(result.logTail?.includes("error: boom"), `log tail: ${result.logTail}`);
  const argvs = await recordedArgv();
  assert(argvs.length === 1, `a failed connect must not poll: ${argvs.length} calls`);
});

await checkAsync("status parses JSON that trails unstructured log lines", async () => {
  const noisy = path.join(stubDir, "noisy.cjs");
  await fs.writeFile(
    noisy,
    `console.log("2026-08-05 loading profile");
console.log(JSON.stringify({ healthy: true, alias: "acceptance" }));
process.exit(0);
`,
    "utf-8"
  );
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${saved ? `${saved} ` : ""}${requireOption(noisy)}`;
  try {
    const result = await tunnelStatus(stubOpts, "acceptance");
    assert(result.json?.healthy === true, `did not recover the JSON: ${result.stdout}`);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

// --------------------------------------------------------- release selection

const RELEASE_VERSION = "v0.0.10";
const ALL_ASSETS = [
  "darwin-amd64", "darwin-arm64",
  "linux-amd64", "linux-arm64",
  "windows-amd64", "windows-arm64",
].map((suffix) => ({
  name: `tunnel-client-${RELEASE_VERSION}-${suffix}.zip`,
  browser_download_url: `https://example.invalid/${suffix}.zip`,
}));

check("the asset name matches the running platform", () => {
  const expectedOs = platformId() === "win32" ? "windows" : platformId();
  const name = tunnelAssetName(RELEASE_VERSION);
  assert(
    name === `tunnel-client-${RELEASE_VERSION}-${expectedOs}-${archId()}.zip`,
    `unexpected asset name for this platform: ${name}`
  );
  assert(
    ALL_ASSETS.some((a) => a.name === name),
    `${name} is not one of the names the release publishes`
  );
});

check("all six published names are generated by the same rule", () => {
  const generated = new Set();
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const arch of ["amd64", "arm64"]) {
      generated.add(tunnelAssetName(RELEASE_VERSION, platform, arch));
    }
  }
  for (const asset of ALL_ASSETS) {
    assert(generated.has(asset.name), `${asset.name} was not generated`);
  }
});

check("selectAsset picks this platform's asset and names what it looked for", () => {
  const chosen = selectAsset({ version: RELEASE_VERSION, assets: ALL_ASSETS });
  assert(chosen.name === tunnelAssetName(RELEASE_VERSION), `chose ${chosen.name}`);

  throws(
    () => selectAsset({ version: RELEASE_VERSION, assets: [] }),
    new RegExp(`has no asset ${tunnelAssetName(RELEASE_VERSION).replace(/\./g, "\\.")}`),
    "missing asset"
  );
});

check("the binary name carries the platform's executable suffix", () => {
  assert(tunnelBinaryName() === `tunnel-client${exeSuffix()}`, `unexpected: ${tunnelBinaryName()}`);
  assert(tunnelCacheDir(RELEASE_VERSION).includes(RELEASE_VERSION), "the cache path should be per-version");
  assert(path.isAbsolute(defaultProfileDir()), "the profile directory should be absolute");
});

check("checksum manifests parse in both published forms", () => {
  const map = parseChecksums(
    [
      `${"a".repeat(64)}  tunnel-client-v0.0.10-linux-arm64.zip`,
      `${"b".repeat(64)} *tunnel-client-v0.0.10-windows-amd64.zip`,
      "# a comment line that is not a digest",
      "",
    ].join("\n")
  );
  assert(map.get("tunnel-client-v0.0.10-linux-arm64.zip") === "a".repeat(64), "two-space form");
  assert(map.get("tunnel-client-v0.0.10-windows-amd64.zip") === "b".repeat(64), "asterisk form");
  assert(map.size === 2, `unexpected entries: ${map.size}`);
  assert(CHECKSUM_ASSET === "SHA256SUMS.txt", "the manifest name is part of the contract");
});

check("sha256 agrees with the platform hash", () => {
  const data = Buffer.from("tunnel-client release bytes");
  assert(sha256(data) === crypto.createHash("sha256").update(data).digest("hex"), "digest mismatch");
});

await checkAsync("resolve prefers an explicit binPath and never downloads unasked", async () => {
  const configured = path.join(tmp, "configured-binary");
  await fs.writeFile(configured, "#!/bin/sh\n", "utf-8");

  const found = await resolveTunnelBinary({ binPath: configured });
  assert(found.source === "config" && found.path === configured, `unexpected: ${JSON.stringify(found)}`);

  const missing = await resolveTunnelBinary({ binPath: path.join(tmp, "nope") });
  assert(missing.source === "missing" && !missing.path, "a missing binPath must not fall through");
  assert(/binPath does not exist/.test(missing.error ?? ""), `unhelpful error: ${missing.error}`);

  // download defaults to false, so nothing may reach the network.
  const noFetch = await resolveTunnelBinary({
    fetchImpl: () => { throw new Error("the network must not be touched"); },
  });
  assert(noFetch.source === "missing" || noFetch.source === "path", `unexpected source: ${noFetch.source}`);
});

check("release tags compare numerically, not lexicographically", () => {
  assert(compareVersions("v0.0.10", "v0.0.9") > 0, "v0.0.10 is newer than v0.0.9");
  assert(compareVersions("v0.1.0", "v0.0.99") > 0, "minor beats patch");
  assert(compareVersions("v1.0.0", "v1.0.0") === 0, "equal tags");
  assert(compareVersions("0.0.10", "v0.0.10") === 0, "the leading v is optional");
});

await checkAsync("a cached download of the newest version wins over the network", async () => {
  const dir = tunnelCacheDir("v0.0.9");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, tunnelBinaryName()), "old", "utf-8");

  const newer = tunnelCacheDir("v0.0.10");
  await fs.mkdir(newer, { recursive: true });
  await fs.writeFile(path.join(newer, tunnelBinaryName()), "new", "utf-8");

  const resolved = await resolveTunnelBinary({
    fetchImpl: () => { throw new Error("the network must not be touched"); },
  });
  assert(resolved.source === "cache", `unexpected source: ${resolved.source}`);
  assert(resolved.version === "v0.0.10", `should prefer the newest cached version, got ${resolved.version}`);
});

// ------------------------------------------------------------ the zip reader

/** Build a zip by hand so the reader is tested against the format, not a library. */
function buildZip(members) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, "utf-8");
    const raw = Buffer.from(member.data ?? "", "utf-8");
    const stored = member.method === 0;
    const body = stored ? raw : zlib.deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.method, 8);
    local.writeUInt32LE(0, 14); // crc is not verified by the reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made on unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(member.method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((member.mode ?? 0o644) & 0o7777) << 16, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

await checkAsync("the zip reader unpacks stored and deflated members", async () => {
  const zipPath = path.join(tmp, "release.zip");
  await fs.writeFile(
    zipPath,
    buildZip([
      { name: tunnelBinaryName(), data: "#!/bin/sh\necho tunnel\n", method: 8, mode: 0o755 },
      { name: "README.md", data: "stored member", method: 0 },
    ])
  );

  const entries = readZipEntries(await fs.readFile(zipPath));
  assert(entries.length === 2, `expected two entries, got ${entries.length}`);
  assert(entries[0].mode === 0o755, `the unix mode should survive: ${entries[0].mode.toString(8)}`);

  const dest = path.join(tmp, "unpacked");
  const written = await extractZip(zipPath, dest);
  assert(written.length === 2, `expected two files, got ${written.length}`);

  const binary = await fs.readFile(path.join(dest, tunnelBinaryName()), "utf-8");
  assert(binary.includes("echo tunnel"), "the deflated member did not round-trip");
  assert((await fs.readFile(path.join(dest, "README.md"), "utf-8")) === "stored member", "stored member");
});

await checkAsync("archive member names that escape the destination are refused", async () => {
  const traversal = path.join(tmp, "traversal.zip");
  await fs.writeFile(traversal, buildZip([{ name: "../escaped.txt", data: "no", method: 0 }]));

  let raised;
  try {
    await extractZip(traversal, path.join(tmp, "unpacked-traversal"));
  } catch (error) {
    raised = error;
  }
  assert(raised, "a traversing member must be refused");
  assert(/outside the extraction directory/.test(raised.message), `unexpected: ${raised.message}`);

  const absolute = path.join(tmp, "absolute.zip");
  await fs.writeFile(absolute, buildZip([{ name: "/etc/cron.d/evil", data: "no", method: 0 }]));
  raised = undefined;
  try {
    await extractZip(absolute, path.join(tmp, "unpacked-absolute"));
  } catch (error) {
    raised = error;
  }
  assert(raised && /refusing absolute path/.test(raised.message), `unexpected: ${raised?.message}`);
});

check("a buffer with no end-of-central-directory is rejected", () => {
  throws(() => readZipEntries(Buffer.alloc(64)), /no end-of-central-directory/, "not a zip");
});

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
