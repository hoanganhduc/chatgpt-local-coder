/**
 * Verify layered configuration: defaults < user file < project file < env <
 * flags, plus per-OS directory discovery and path-list splitting.
 *
 * Runs entirely inside a temp CLC_CONFIG_DIR so the developer's real config is
 * never read or written.
 */
import fs from "fs";
import os from "os";
import path from "path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clc-config-test-"));
const configHome = path.join(sandbox, "config");
const projectRoot = path.join(sandbox, "project");
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });

process.env.CLC_CONFIG_DIR = configHome;

const { loadConfig, writeUserConfig, splitPathList } = await import("../dist/config/load.js");
const { configDir, configFilePath, projectConfigFilePath, stateDir, cacheDir } = await import(
  "../dist/config/paths.js"
);

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

/** Clear every env var the config layer reads, so cases start from defaults. */
const ENV_KEYS = [
  "WORKSPACE_PATH", "EXTRA_WORKSPACE_PATHS", "WORKSPACE_PATHS", "ALLOWED_WORKSPACE_PATHS",
  "PORT", "ADMIN_PORT", "SHELL_TIMEOUT", "CHATGPT_TOOL_PROFILE",
  "CLC_PERMISSION_PROFILE", "CLC_BIND_HOST", "MCP_BIND_HOST", "CLC_SKILL_ROOTS",
  "CLC_SKILL_EXECUTION", "CLC_SETTINGS_IMPORT", "CLC_DELEGATES", "CLC_HOOKS",
  "CLC_TUNNEL_ALIAS", "CLC_TUNNEL_BIN",
];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }

// --- directory discovery -----------------------------------------------
try {
  if (configDir() !== configHome) throw new Error(`configDir ${configDir()} != ${configHome}`);
  ok("CLC_CONFIG_DIR overrides configDir");

  if (path.dirname(configFilePath()) !== configHome) throw new Error("configFilePath outside configDir");
  if (path.basename(configFilePath()) !== "config.json") throw new Error("config file misnamed");
  ok("configFilePath = <configDir>/config.json");

  if (projectConfigFilePath(projectRoot) !== path.join(projectRoot, ".chatgpt-local-coder.json")) {
    throw new Error("project config path wrong");
  }
  ok("projectConfigFilePath = <root>/.chatgpt-local-coder.json");

  for (const [name, fn] of [["stateDir", stateDir], ["cacheDir", cacheDir]]) {
    const dir = fn();
    if (!path.isAbsolute(dir)) throw new Error(`${name} is not absolute: ${dir}`);
    if (!dir.includes("chatgpt-local-coder")) throw new Error(`${name} not app-scoped: ${dir}`);
  }
  ok("stateDir and cacheDir are absolute and app-scoped");
} catch (e) { fail("paths", e.message); }

// --- path list splitting ------------------------------------------------
try {
  const semis = splitPathList("/a;/b;/c");
  if (semis.join("|") !== "/a|/b|/c") throw new Error(`semicolon split gave ${semis.join("|")}`);
  ok('";" separated lists split on every platform (backward compatible)');

  if (splitPathList("").length !== 0) throw new Error("empty string should give []");
  if (splitPathList(undefined).length !== 0) throw new Error("undefined should give []");
  ok("empty and undefined give an empty list");

  const quoted = splitPathList('"/quoted/path";\'/single/quoted\'');
  if (quoted[0] !== "/quoted/path" || quoted[1] !== "/single/quoted") {
    throw new Error(`quotes not stripped: ${JSON.stringify(quoted)}`);
  }
  ok("surrounding quotes are stripped");

  if (process.platform !== "win32") {
    const colons = splitPathList("/a:/b");
    if (colons.join("|") !== "/a|/b") throw new Error(`colon split gave ${colons.join("|")}`);
    ok('":" also splits on POSIX');

    // A Windows drive path in a POSIX env must not be shredded at "C:".
    const drive = splitPathList("C:\\Users\\me\\proj");
    if (drive.length !== 1 || drive[0] !== "C:\\Users\\me\\proj") {
      throw new Error(`drive path shredded: ${JSON.stringify(drive)}`);
    }
    ok("a Windows drive path is not split at the drive colon");
  }
} catch (e) { fail("splitPathList", e.message); }

// --- defaults -----------------------------------------------------------
try {
  clearEnv();
  const { config } = loadConfig({ cwd: projectRoot });
  if (config.permissionProfile !== "workspace") throw new Error(`default profile ${config.permissionProfile}`);
  if (config.bindHost !== "127.0.0.1") throw new Error(`default bindHost ${config.bindHost}`);
  if (config.port !== 3000 || config.adminPort !== 3001) throw new Error("default ports wrong");
  if (config.shellTimeoutSec !== 120) throw new Error("default shell timeout wrong");
  if (config.toolProfile !== "slim") throw new Error("default tool profile wrong");
  if (config.skills.allowExecution !== true) throw new Error("skills.allowExecution default wrong");
  if (config.settings.import !== true) throw new Error("settings.import default wrong");
  if (config.tunnel.alias !== "chatgpt-local-coder") throw new Error("tunnel alias default wrong");
  ok("defaults: workspace profile, 127.0.0.1 bind, ports 3000/3001, nested defaults present");

  if (config.workspaceRoots.length !== 1 || config.workspaceRoots[0] !== path.resolve(projectRoot)) {
    throw new Error(`workspaceRoots fell back to ${JSON.stringify(config.workspaceRoots)}`);
  }
  ok("workspaceRoots falls back to cwd when nothing is configured");
} catch (e) { fail("defaults", e.message); }

// --- user file layer ----------------------------------------------------
try {
  clearEnv();
  const written = writeUserConfig({ port: 4100, permissionProfile: "open", skills: { maxRuntimeSec: 45 } });
  if (written !== configFilePath()) throw new Error("writeUserConfig wrote elsewhere");

  const { config } = loadConfig({ cwd: projectRoot });
  if (config.port !== 4100) throw new Error(`user port not applied: ${config.port}`);
  if (config.permissionProfile !== "open") throw new Error("user profile not applied");
  if (config.skills.maxRuntimeSec !== 45) throw new Error("nested user value not applied");
  if (config.skills.allowExecution !== true) throw new Error("sibling nested default lost on partial write");
  ok("user file overrides defaults and a partial nested object keeps its siblings");
} catch (e) { fail("user layer", e.message); }

// --- project file layer -------------------------------------------------
try {
  clearEnv();
  fs.writeFileSync(
    projectConfigFilePath(projectRoot),
    JSON.stringify({ port: 4200, toolProfile: "full" }),
    "utf-8"
  );
  const { config } = loadConfig({ cwd: projectRoot });
  if (config.port !== 4200) throw new Error(`project port not applied: ${config.port}`);
  if (config.toolProfile !== "full") throw new Error("project toolProfile not applied");
  if (config.permissionProfile !== "open") throw new Error("user value lost when project layer present");
  ok("project file beats user file and leaves untouched user keys alone");
} catch (e) { fail("project layer", e.message); }

// --- env layer ----------------------------------------------------------
try {
  clearEnv();
  process.env.PORT = "4300";
  process.env.CLC_PERMISSION_PROFILE = "readonly";
  process.env.CLC_BIND_HOST = "0.0.0.0";
  process.env.WORKSPACE_PATH = projectRoot;
  const { config } = loadConfig({ cwd: sandbox });
  if (config.port !== 4300) throw new Error(`env port not applied: ${config.port}`);
  if (config.permissionProfile !== "readonly") throw new Error("env profile not applied");
  if (config.bindHost !== "0.0.0.0") throw new Error("env bindHost not applied");
  if (config.workspaceRoots[0] !== path.resolve(projectRoot)) throw new Error("env workspace root not applied");
  ok("env beats project file");

  process.env.CLC_PERMISSION_PROFILE = "nonsense";
  const { config: c2 } = loadConfig({ cwd: sandbox });
  if (c2.permissionProfile === "nonsense") throw new Error("invalid profile accepted");
  ok("an invalid CLC_PERMISSION_PROFILE is ignored rather than accepted");
} catch (e) { fail("env layer", e.message); }

// --- flags layer --------------------------------------------------------
try {
  const { config } = loadConfig({ cwd: sandbox, overrides: { port: 4400, permissionProfile: "workspace" } });
  if (config.port !== 4400) throw new Error(`flags port not applied: ${config.port}`);
  if (config.permissionProfile !== "workspace") throw new Error("flags profile not applied");
  ok("CLI flags beat env");
} catch (e) { fail("flags layer", e.message); }

// --- skipEnv ------------------------------------------------------------
try {
  process.env.PORT = "4999";
  const { config } = loadConfig({ cwd: sandbox, skipEnv: true });
  if (config.port === 4999) throw new Error("skipEnv still read PORT");
  ok("skipEnv ignores the environment layer");
} catch (e) { fail("skipEnv", e.message); }

// --- malformed file is reported, not fatal ------------------------------
try {
  clearEnv();
  fs.writeFileSync(configFilePath(), "{ not json", "utf-8");
  const { config, layers } = loadConfig({ cwd: projectRoot });
  const userLayer = layers.find((l) => l.id === "user");
  if (!userLayer?.error) throw new Error("malformed user config did not record an error");
  if (typeof config.port !== "number") throw new Error("load did not fall through to lower layers");
  ok("a malformed config file records an error and does not crash the load");
} catch (e) { fail("malformed file", e.message); }

// --- arrays replace, they do not concatenate ----------------------------
try {
  clearEnv();
  fs.writeFileSync(configFilePath(), JSON.stringify({ workspaceRoots: ["/one", "/two"] }), "utf-8");
  fs.writeFileSync(projectConfigFilePath(projectRoot), JSON.stringify({ workspaceRoots: ["/three"] }), "utf-8");
  const { config } = loadConfig({ cwd: projectRoot });
  if (config.workspaceRoots.length !== 1) {
    throw new Error(`arrays concatenated: ${JSON.stringify(config.workspaceRoots)}`);
  }
  ok("array values replace rather than concatenate across layers");
} catch (e) { fail("array merge", e.message); }

// --- project discovery is not relocated by the user config --------------
try {
  clearEnv();
  // The user config names roots that do not exist. The project file in cwd
  // must still be found.
  fs.writeFileSync(configFilePath(), JSON.stringify({ workspaceRoots: ["/nonexistent-root"] }), "utf-8");
  fs.writeFileSync(projectConfigFilePath(projectRoot), JSON.stringify({ port: 4777 }), "utf-8");
  const { config, layers } = loadConfig({ cwd: projectRoot });
  if (!layers.some((l) => l.id === "project")) throw new Error("project layer was not discovered");
  if (config.port !== 4777) throw new Error(`project port not applied: ${config.port}`);
  ok("user-config roots do not relocate project-file discovery away from cwd");

  // An explicit WORKSPACE_PATH, by contrast, does anchor discovery.
  process.env.WORKSPACE_PATH = projectRoot;
  const { config: c3 } = loadConfig({ cwd: sandbox });
  if (c3.port !== 4777) throw new Error("WORKSPACE_PATH did not anchor project discovery");
  ok("WORKSPACE_PATH anchors project-file discovery");
} catch (e) { fail("project discovery anchor", e.message); }

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
