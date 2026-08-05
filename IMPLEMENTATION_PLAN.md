# Implementation Plan — Provider-Neutral Local Coding Host

Status: approved for implementation
Baseline commit: `81a53c9`
Date locked: 2026-08-05

This document is the handoff spec for turning `chatgpt-local-coder` from a
Windows-first ChatGPT MCP bridge into a cross-platform local coding host that
runs the same skills and settings other agent CLIs use. It is decision-complete:
an implementer should not need to choose architecture or infer expected
behaviour.

---

## 1. Locked product decisions

These were chosen by the user and are not open for re-litigation.

| Decision | Choice | Consequence |
|---|---|---|
| Scope | Staged core + skills | Cross-platform CLI/tunnel, real skills/settings support, safety, tests. No separate chat UI, no local mirror of ChatGPT chat history. |
| Default permissions | Workspace scoped | File mutation restricted to configured workspace roots; explicit `open` profile for trusted use. |
| Distribution | npm first | One Node CLI for Windows, Linux, macOS. Standalone binaries deferred. |
| Skill execution | Full source semantics | Dynamic shell, hooks, forked contexts and agent directives are executed, not merely parsed. |
| Settings compatibility | Broad import | MCP servers, permissions, hooks, model and agent settings from Codex/Claude/Grok/OpenCode are translated into host behaviour. |
| Runtime | Foreground + services | `up` is foreground by default; `service install` adds systemd / launchd / Windows Service. |
| ai-agents-skills | Two-repo target | A native `chatgpt-local-coder` install target is added to `~/ai-agents-skills`; the host loader stays generic. |
| Fork backend | Local CLI delegates | `context: fork` and named subagents dispatch to installed `codex` / `claude` / `grok` / `opencode` CLIs. |
| Config sync | Live adapters | Source settings are read into a normalized runtime view at startup and on refresh. Source files are never modified. |
| Shell safety | Approved host shell | File tools enforce workspace boundaries; every shell/skill execution is marked open-world and approval-required, and is documented as having host-user access. |
| Secrets | Private files | App-owned files with mode `0600` (restricted DACL on Windows), plus environment overrides. |
| Services | Server + tunnel | The MCP server installs as a native user service; tunnel lifecycle is delegated to official tunnel-client managed runtimes. |

### 1.1 Platform boundary (must be stated honestly, never worked around)

An MCP server exposes tools to ChatGPT Web. It **cannot** create a new ChatGPT
Web model turn and **cannot** fork the browser conversation. Therefore
`context: fork`, named subagents and agent directives are implemented by
delegating to a locally installed agent CLI and returning a bounded result to
the parent chat. Any documentation that implies browser-side forking is wrong.

---

## 2. Current state and gaps

Verified against the baseline commit:

| Area | Current | Gap |
|---|---|---|
| Tunnel lifecycle | `openai-tunnel.ps1` (PowerShell only), pinned `v0.0.10` | No Linux/macOS path; version pin instead of `releases/latest` discovery |
| Shell | `powershell.exe` on Windows, `bash -lc` elsewhere (`src/lib/persistent-shell.ts:114`) | No zsh/sh fallback, no shell override, no process-tree kill |
| Skills | `.claude/skills` only, max 20 summaries (`src/lib/skills-loader.ts:22`) | No other roots, no read/run, no frontmatter beyond name/description |
| Permissions | Stub returning "open" for everything (`src/lib/permissions.ts`) | No workspace scoping, no profiles |
| Paths | `validatePath` resolves anything (`src/lib/path-security.ts:31`) | No boundary enforcement |
| Listener | `app.listen(PORT)` binds all interfaces (`src/index.ts:275`) | LAN/Tailscale exposure |
| Settings | None | No Codex/Claude/Grok/OpenCode import |
| Entry point | `dist/index.js` server only | No CLI, no doctor, no service management |
| Verification | `scripts/run-verification.mjs:5` hardcodes a Windows temp path | Fails on Linux/macOS |
| CI | None | No cross-platform gate |

---

## 3. Target architecture

```
src/
  cli/                 # chatgpt-local-coder command surface
    main.ts            #   argv parse + dispatch
    commands/          #   init, doctor, up, down, status, tunnel, service,
                       #   skills, settings, config
  config/
    schema.ts          # zod schema for host config
    load.ts            # layered resolution (defaults < file < env < flags)
    paths.ts           # config/state/cache dir discovery per OS
  lib/
    platform.ts        # OS, arch, shell, process-tree kill, exe suffix
    secrets.ts         # private-file secret store with env overrides
    permissions.ts     # REWRITTEN: profile engine
    path-security.ts   # REWRITTEN: boundary enforcement
  skills/
    discover.ts        # multi-root discovery
    frontmatter.ts     # YAML-ish frontmatter parse (full field set)
    registry.ts        # in-memory registry + refresh
    run.ts             # bounded skill script execution
  settings/
    types.ts           # NormalizedSettings
    claude.ts codex.ts grok.ts opencode.ts
    merge.ts           # precedence + conflict reporting
    index.ts           # live adapter facade
  delegates/
    registry.ts        # detect installed CLIs
    run.ts             # bounded delegate invocation
  hooks/
    engine.ts          # event dispatch
    matchers.ts        # tool-name/glob matching
  tunnel/
    release.ts         # releases/latest discovery + download + checksum
    runtime.ts         # runtimes create/connect/status/stop/rm wrappers
  services/
    systemd.ts launchd.ts windows.ts index.ts
  tools/
    skills.ts          # skill_list / skill_read / skill_run
    delegate.ts        # agent_delegate
    settings.ts        # settings_status
```

Existing modules keep their paths; `server-factory.ts` gains the new tool
registrations.

---

## 4. Task breakdown

Tasks are ordered. Each names its files, its interface, and its acceptance test.

### T1 — Platform adapter

**Files:** `src/lib/platform.ts` (new)

```ts
export type PlatformId = "win32" | "darwin" | "linux";
export interface ShellSpec { command: string; args: (script: string) => string[]; label: string; }

export function platformId(): PlatformId;
export function archId(): "amd64" | "arm64";
export function defaultShell(): ShellSpec;       // honours CLC_SHELL override
export function exeSuffix(): string;             // ".exe" on win32 else ""
export async function killProcessTree(pid: number): Promise<void>;
export function isWindows(): boolean;
```

Shell selection order:

1. `CLC_SHELL` env (absolute path or bare name) — used verbatim.
2. Windows: `pwsh.exe` if on PATH, else `powershell.exe`, args
   `["-NoProfile", "-NonInteractive", "-Command", script]`.
3. macOS: `$SHELL` if it ends in `zsh`/`bash`/`sh`, else `/bin/zsh`, args
   `["-lc", script]`.
4. Linux: `$SHELL` if it ends in `bash`/`zsh`/`sh`, else `/bin/sh`, args
   `["-lc", script]`.

`killProcessTree` uses `taskkill /PID <pid> /T /F` on Windows and
`process.kill(-pgid)` after `spawn(..., { detached: true })` elsewhere.

**Acceptance:** `scripts/test-platform.mjs` asserts a non-empty shell command,
an arch in `{amd64, arm64}`, and that `CLC_SHELL=/bin/sh` is honoured.

### T2 — Config directories and layered config

**Files:** `src/config/paths.ts`, `src/config/schema.ts`, `src/config/load.ts` (new)

Directory resolution:

| Purpose | Windows | macOS | Linux |
|---|---|---|---|
| config | `%APPDATA%\chatgpt-local-coder` | `~/Library/Application Support/chatgpt-local-coder` | `$XDG_CONFIG_HOME/chatgpt-local-coder` or `~/.config/chatgpt-local-coder` |
| state | `%LOCALAPPDATA%\chatgpt-local-coder\state` | `~/Library/Application Support/chatgpt-local-coder/state` | `$XDG_STATE_HOME/chatgpt-local-coder` or `~/.local/state/chatgpt-local-coder` |
| cache | `%LOCALAPPDATA%\chatgpt-local-coder\cache` | `~/Library/Caches/chatgpt-local-coder` | `$XDG_CACHE_HOME/chatgpt-local-coder` or `~/.cache/chatgpt-local-coder` |

Config resolution precedence, lowest to highest:

1. Built-in defaults.
2. `<configDir>/config.json`.
3. `<workspaceRoot>/.chatgpt-local-coder.json`.
4. Environment variables (existing names stay valid).
5. CLI flags.

Schema (zod), with defaults:

```ts
{
  workspaceRoots: string[];                 // default [cwd]
  permissionProfile: "workspace" | "open" | "readonly";  // default "workspace"
  bindHost: string;                         // default "127.0.0.1"
  port: number;                             // default 3000
  adminPort: number;                        // default 3001
  shellTimeoutSec: number;                  // default 120
  toolProfile: "slim" | "full";             // default "slim"
  skills: { roots: string[]; enabled: string[]; disabled: string[];
            allowExecution: boolean; maxRuntimeSec: number };   // allowExecution default true
  settings: { import: boolean; sources: ("claude"|"codex"|"grok"|"opencode")[] };
  delegates: { enabled: boolean; order: string[]; timeoutSec: number };
  hooks: { enabled: boolean };
  tunnel: { alias: string; profileDir?: string; binPath?: string };
}
```

Path lists split on `path.delimiter` **and** `;`, so existing Windows-style
`WORKSPACE_PATH=a;b` values keep working on all platforms.

**Acceptance:** `scripts/test-config.mjs` proves each precedence layer overrides
the one below it and that `;`-separated roots parse on Linux.

### T3 — Secrets store

**Files:** `src/lib/secrets.ts` (new)

```ts
export async function getSecret(name: string): Promise<string | undefined>;
export async function setSecret(name: string, value: string): Promise<void>;
export async function deleteSecret(name: string): Promise<void>;
export function secretsPath(): string;
```

Read order: `process.env[name]` → `<configDir>/secrets.json`. Writes go to the
file, created with mode `0600`; on Windows the file is created then locked with
`icacls <path> /inheritance:r /grant:r "%USERNAME%":F`. Values are never logged;
`doctor` prints only `name: set` / `name: unset`.

**Acceptance:** `scripts/test-secrets.mjs` round-trips a value, asserts mode
`0600` on POSIX, and asserts env override wins.

### T4 — Permission engine

**Files:** `src/lib/permissions.ts` (rewrite), `src/lib/path-security.ts` (rewrite)

```ts
export type PermissionProfile = "workspace" | "open" | "readonly";
export function getPermissionProfile(): PermissionProfile;
export function setPermissionContext(ctx: { profile: PermissionProfile; roots: string[] }): void;
export function isPathAllowed(target: string, intent: "read" | "write"): boolean;
export function requirePathAllowed(target: string, intent: "read" | "write"): void;
export function canRunCommands(): boolean;
export function describePermissionProfile(): string;
```

Behaviour per profile:

| Profile | Read | Write | Commands |
|---|---|---|---|
| `workspace` (default) | anywhere | inside workspace roots only | allowed, approval-required annotation |
| `open` | anywhere | anywhere | allowed |
| `readonly` | anywhere | denied | denied |

Boundary check: resolve the target with `fs.realpath` on the nearest existing
ancestor, then require `resolved === root || resolved.startsWith(root + sep)`
for some root. This defeats `..` traversal and symlink escape. Comparison is
case-insensitive on Windows and macOS.

`validatePath(input, intent)` gains a required `intent` argument and calls
`requirePathAllowed`. Every write-capable filesystem tool passes `"write"`;
readers pass `"read"`.

Denial message must name the profile and the roots, and state the exact
remediation: `set permissionProfile to "open" or add the path to workspaceRoots`.

**Acceptance:** `scripts/test-permissions.mjs` covers: write outside root denied
under `workspace`; the same write allowed under `open`; symlink from inside a
root to outside denied; read outside root allowed under `workspace`; all writes
denied under `readonly`.

### T5 — Loopback binding

**Files:** `src/index.ts`, `src/admin/server.ts`

`app.listen(port, bindHost)` where `bindHost` defaults to `127.0.0.1`. If the
resolved bind host is not a loopback address, log a single explicit warning
naming the exposure, at startup, before the listener is announced. The admin
server already binds `127.0.0.1` and keeps doing so unconditionally.

**Acceptance:** `scripts/test-bind.mjs` starts the server and asserts the
listening address is `127.0.0.1`.

### T6 — Skills engine

**Files:** `src/skills/frontmatter.ts`, `src/skills/discover.ts`,
`src/skills/registry.ts`, `src/skills/run.ts` (new); `src/lib/skills-loader.ts`
becomes a thin re-export for the instruction summary.

Discovery roots, in precedence order (first match wins on duplicate `name`):

1. Each `<workspaceRoot>/.agents/skills`
2. Each `<workspaceRoot>/.claude/skills`
3. `$AI_AGENTS_SKILLS_HOME` (if set)
4. `~/.claude/skills`
5. `~/.codex/skills`
6. `~/ai-agents-skills/canonical/skills`
7. Any extra `skills.roots` from config

Each skill is a directory containing `SKILL.md`. Frontmatter fields parsed:
`name`, `description`, `allowed-tools`, `context`, `model`, `agent`, `hooks`,
`platforms`, `runtime`, `entrypoint`, `license`, `metadata`. Unknown keys are
retained verbatim in `raw` so nothing is silently dropped.

Progressive disclosure: the MCP instruction block lists only `name` and
`description` (capped at 200 chars each, no 20-skill limit — instead a total
byte cap of 12 KB with an explicit `… and N more (use skill_list)` line). Full
instructions and bundled resources load only through `skill_read`.

Execution (`skill_run`): resolves `entrypoint` relative to the skill directory,
requires `runtime` in `{node, python, bash, powershell, none}`, and refuses to
run when the current platform is not in `platforms` (default: all). The command
runs through the platform shell with the configured timeout, inheriting the
permission profile's command policy. A skill whose `runtime` is `bash` on native
Windows produces the diagnostic `skill "<name>" requires bash; install Git Bash
or run under WSL` rather than an obscure spawn error.

**Acceptance:** `scripts/test-skills.mjs` creates a temp tree with skills in two
roots, asserts precedence, asserts frontmatter round-trip including unknown
keys, asserts the byte cap adds the overflow line, asserts a `platforms: [linux]`
skill is refused on a simulated `win32`, and asserts `skill_run` returns the
script's stdout.

### T7 — Settings adapters

**Files:** `src/settings/types.ts`, `claude.ts`, `codex.ts`, `grok.ts`,
`opencode.ts`, `merge.ts`, `index.ts` (new)

Normalized shape:

```ts
export interface NormalizedSettings {
  sources: { id: string; path: string; loadedAt: string; ok: boolean; error?: string }[];
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  mcpServers: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string,string> }>;
  hooks: Record<string, HookMatcher[]>;
  model?: string;
  agents: Record<string, { description?: string; model?: string; tools?: string[] }>;
  skillRoots: string[];
  conflicts: { key: string; winner: string; losers: string[] }[];
}
```

Sources read (never written):

| id | files |
|---|---|
| `claude` | `~/.claude/settings.json`, `<ws>/.claude/settings.json`, `<ws>/.claude/settings.local.json`; agents from `~/.claude/agents/*.md` |
| `codex` | `~/.codex/config.toml` (minimal TOML subset), `~/.codex/AGENTS.md` presence |
| `grok` | `~/.grok/settings.json` if present |
| `opencode` | `~/.config/opencode/opencode.json` or `~/.opencode.json` if present |

Precedence, lowest to highest: `codex` < `grok` < `opencode` < `claude` <
host config. Every override is recorded in `conflicts` so `settings_status`
can explain why a value won.

Security semantics: imported `permissions.deny` entries are always applied.
Imported `permissions.allow` entries never widen the host permission profile —
they only reduce prompting inside what the profile already permits. This is the
one place where import is deliberately asymmetric, and it must be documented.

Live refresh: `loadSettings()` at startup, `refreshSettings()` exposed through
the `settings_status` tool and `chatgpt-local-coder settings refresh`. No
watcher — refresh is explicit, so behaviour is reproducible.

**Acceptance:** `scripts/test-settings.mjs` builds a fake HOME with all four
sources, asserts precedence order, asserts a deny from a low-precedence source
survives a high-precedence allow, and asserts a malformed file yields
`ok: false` with an error string instead of throwing.

### T8 — Delegate agents

**Files:** `src/delegates/registry.ts`, `src/delegates/run.ts`,
`src/tools/delegate.ts` (new)

Detection probes `codex`, `claude`, `grok`, `opencode` on PATH and records
version output. Invocation templates:

| CLI | Argv |
|---|---|
| `claude` | `["-p", prompt, "--output-format", "text"]` |
| `codex` | `["exec", prompt]` |
| `grok` | `["-p", prompt]` |
| `opencode` | `["run", prompt]` |

`agent_delegate({ prompt, agent?, cwd?, timeout_sec? })` picks the first
available CLI from `delegates.order`, runs it with `cwd` restricted by the
permission profile, caps runtime at `delegates.timeoutSec` (default 300), caps
captured output at 200 KB, and returns `{ delegate, exit_code, output,
truncated }`. On no delegate available it returns a structured error naming
which CLIs were probed — it does not throw.

Skill directives `context: fork` and `agent: <name>` route through this path.

**Acceptance:** `scripts/test-delegates.mjs` uses a stub executable on a
temporary PATH to assert argv construction, timeout enforcement, output
truncation, and the no-delegate error shape.

### T9 — Hooks engine

**Files:** `src/hooks/engine.ts`, `src/hooks/matchers.ts` (new); existing
`src/lib/post-edit-hooks.ts` is refactored to register itself as a `PostToolUse`
hook rather than being called directly.

Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`. A hook entry is
`{ matcher: string; hooks: { type: "command"; command: string; timeout?: number }[] }`
— the Claude shape, so imported settings work unchanged. `matcher` is a regex
over the tool name.

`PreToolUse` hooks may block: a non-zero exit with output on stderr aborts the
tool call and returns that text to the model. `PostToolUse` failures are
reported but never abort. Hook commands inherit the shell and the command
permission policy. Total hook budget per tool call is 30 s.

**Acceptance:** `scripts/test-hooks.mjs` asserts matcher selection, that a
blocking `PreToolUse` prevents execution, that a failing `PostToolUse` does not,
and that the existing post-edit behaviour still fires.

### T10 — Tunnel manager

**Files:** `src/tunnel/release.ts`, `src/tunnel/runtime.ts` (new)

Binary acquisition: query
`https://api.github.com/repos/openai/tunnel-client/releases/latest`, select the
asset matching `tunnel-client-<version>-<os>-<arch>.zip` for the current
platform, download to the cache dir, verify against the release checksum file,
unzip, and mark executable. The pinned `v0.0.10` in the PowerShell wrapper is
replaced by this discovery. `tunnel.binPath` in config overrides everything.

Lifecycle wrappers over the verified contract (confirmed against the v0.0.10
binary):

```
tunnel-client runtimes create  --alias <alias> [--name ...] [--description ...]
tunnel-client runtimes connect --alias <alias> --profile <name>
                               --profile-dir <dir> --mcp-server-url <url>
                               --runtime-api-key <ref> [--tunnel-id <id>] --json
tunnel-client runtimes status  <alias> --json
tunnel-client runtimes stop    <alias> --json
tunnel-client runtimes rm      <alias> --json
```

Key handling: `--runtime-api-key` and `--admin-key` accept only reference forms
(`env:NAME` or `file:/path`). The manager always passes `file:<secretsPath>`-style
references produced by T3; it must never pass literal key material, because the
client rejects inline secrets.

`connect` returns JSON containing `health_url`, `healthy`, `config_path` and
`launch_diagnostics.log_path`. After `connect`, the manager polls
`runtimes status <alias>` until `healthy` is true or a 30 s deadline passes, and
surfaces `log_tail` on failure. Note that `connect` starts a managed background
runtime as a side effect — the CLI must never invoke it merely to inspect help.

**Acceptance:** `scripts/test-tunnel.mjs` uses a stub `tunnel-client` on PATH to
assert argv construction, that only reference-form keys are passed, that a
`healthy: false` response surfaces the log tail, and that asset-name selection
matches the running platform.

### T11 — Services

**Files:** `src/services/systemd.ts`, `launchd.ts`, `windows.ts`, `index.ts` (new)

| OS | Mechanism | Unit location |
|---|---|---|
| Linux | systemd **user** unit | `~/.config/systemd/user/chatgpt-local-coder.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.chatgpt-local-coder.plist` |
| Windows | `schtasks` logon task | task name `ChatGPTLocalCoder` |

Windows uses a scheduled task rather than a Windows Service because installing a
true service requires elevation and a service host wrapper; the task runs at
logon in the user context, which matches the user-scoped model of the other two.
This limitation is stated in the docs, not hidden.

`service install` writes the unit, `service uninstall` removes it, and
`service status` reports whether it is loaded and running. Tunnel lifecycle is
**not** duplicated here — it is delegated to tunnel-client managed runtimes.

**Acceptance:** `scripts/test-services.mjs` asserts generated unit content for
all three platforms (pure string generation, no installation) including correct
absolute paths and environment.

### T12 — CLI

**Files:** `src/cli/main.ts`, `src/cli/commands/*.ts` (new); `package.json` `bin`
gains `chatgpt-local-coder` and `clc`, keeping `codex-mcp-server` for
compatibility.

| Command | Behaviour |
|---|---|
| `init` | Interactive-free by default; writes `<configDir>/config.json`, prompts only with `--interactive`. Flags: `--workspace <path>` (repeatable), `--profile <workspace\|open\|readonly>`, `--port`, `--tunnel-alias`. |
| `doctor` | Checks Node version, config validity, workspace roots exist, port availability, tunnel binary present, delegate CLIs, settings sources, skill roots, secrets set/unset. Exit 0 only when no `error`-level finding. Human table by default, `--json` for machines. |
| `up` | Foreground. Starts the MCP server, and unless `--no-tunnel`, connects the tunnel runtime. Ctrl-C stops both. |
| `down` | Stops the tunnel runtime and any service-managed server. |
| `status` | Server health, tunnel runtime status, session count. |
| `tunnel init\|connect\|status\|stop\|rm` | Thin wrappers over T10. |
| `service install\|uninstall\|status` | T11. |
| `skills list\|read\|run` | T6 from the terminal. |
| `settings show\|refresh` | T7. |
| `config get\|set\|path` | Read/modify `<configDir>/config.json`. |

Argument parsing is hand-rolled (no new dependency): a small
`parseArgs`-over-`node:util` wrapper. `--help` on every command.

**Acceptance:** `scripts/test-cli.mjs` asserts `doctor --json` emits a parseable
report, `config set`/`get` round-trips, and unknown commands exit non-zero with
usage text.

### T13 — ai-agents-skills target

**Files (other repo, `~/ai-agents-skills`):**
`installer/ai_agents_skills/agents.py`, `manifest/target-state.yaml`,
`docs/agent-locations.md`, `docs/surfaces.md`

Add target `chatgpt-local-coder`:

```python
AgentTarget(
    name="chatgpt-local-coder",
    home=root / ".chatgpt-local-coder",
    skills_dir=root / ".chatgpt-local-coder" / "skills",
    instructions_file=root / ".chatgpt-local-coder" / "AGENTS.md",
    optional_skills_dirs=(root / ".agents" / "skills",),
    artifact_dirs={
        "agent-persona": root / ".chatgpt-local-coder" / "agents",
        "template":      root / ".chatgpt-local-coder" / "templates",
        "instruction-doc": root / ".chatgpt-local-coder" / "instructions",
        "command":       root / ".chatgpt-local-coder" / "commands",
        "tool-shim":     root / ".chatgpt-local-coder" / "tools",
    },
)
```

Register it in `DEFAULT_AGENT_NAMES`, `KNOWN_AGENT_NAMES` and
`ADAPTER_AGENT_NAMES`, and add a `manifest/target-state.yaml` entry with
`home: .chatgpt-local-coder`, `cli_candidates: ["chatgpt-local-coder", "clc"]`,
`version_argv: ["--version"]`, `runtime_requirements: ["node-runtime", "git-cli"]`,
and readiness checks `["cli-version", "managed-skill-visibility"]`.

Correspondingly, `~/.chatgpt-local-coder/skills` is added to the host's
discovery roots (T6, position 5).

**Acceptance:** `python3 -m installer.ai_agents_skills.cli plan --agent
chatgpt-local-coder` produces a plan without error, and the repo's own test
suite still passes.

### T14 — Tests and CI

**Files:** `scripts/test-*.mjs` per task above, `scripts/run-all-tests.mjs`
updated, `.github/workflows/ci.yml` (new)

CI matrix: `windows-latest`, `ubuntu-latest`, `macos-latest` × Node 20 and 22.
Steps: `npm ci`, `npm run build`, `npm run test:all`. Any test that requires a
real tunnel or a real delegate CLI must stub it — CI never reaches the network
except for `npm ci`.

Fix `scripts/run-verification.mjs:5` to use `os.tmpdir()` instead of the
hardcoded Windows path.

### T15 — Documentation

**Files:** `README.md`, `AGENTS.md`, `docs/cross-platform.md` (new)

README must lead with the three-OS quickstart (`npm i -g`,
`chatgpt-local-coder init`, `doctor`, `up`), state the workspace-scoped default
and how to widen it, and state plainly that approved shell commands run with
full host-user privileges. The stale "Apps & Connectors → Advanced" instructions
are replaced with the current Developer Mode path, flagged as UI-version
sensitive. `AGENTS.md` keeps its Vietnamese onboarding voice but drops the
"Full machine access — no restrictions" claim, which stops being true.

---

## 5. Acceptance gates

The work is done when all of the following hold:

1. `npm run build` is clean.
2. `npm run test:all` passes on Linux, and the CI matrix passes on all three
   operating systems.
3. `chatgpt-local-coder doctor --json` exits 0 on a correctly configured host.
4. A write outside the workspace roots is denied under the default profile and
   permitted under `open`.
5. The MCP listener binds `127.0.0.1` unless explicitly overridden.
6. A skill in `~/ai-agents-skills/canonical/skills` is discoverable, readable and
   runnable from the host.
7. Settings from at least two sources are visible in `settings_status`, with the
   precedence winner explained.
8. `agent_delegate` returns a bounded result from an installed CLI, or a
   structured error naming the CLIs it probed.
9. No secret value appears in any log, tool output, or `doctor` report.

## 6. Evidence status

Version-sensitive items to revalidate at execution time, not to be treated as
settled:

- ChatGPT Developer Mode UI location and entitlement by plan tier.
- tunnel-client release asset naming and flag surface (verified for `v0.0.10`;
  discovery now targets `releases/latest`).
- Delegate CLI argv surfaces, which change between releases — each is probed at
  runtime and failures are reported, not assumed.
