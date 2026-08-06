<div align="center">

# ChatGPT Local Coder

**A provider-neutral local coding host over MCP — files, shell, git, patches, skills, delegates.**

[![CI](https://github.com/hoanganhduc/chatgpt-local-coder/actions/workflows/ci.yml/badge.svg)](https://github.com/hoanganhduc/chatgpt-local-coder/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Developer%20Mode-10a37f?style=flat-square)](https://developers.openai.com/api/docs/guides/developer-mode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Platforms](https://img.shields.io/badge/Native-Windows%20%7C%20macOS%20%7C%20Linux-0078d4?style=flat-square)](docs/cross-platform.md)

[Quick Start](#-quick-start) · [Permissions](#-permissions) · [Connect ChatGPT](#-connect-chatgpt) · [Tools](#-tools) · [Skills](#-skills) · [Cross-platform](docs/cross-platform.md) · [Tiếng Việt](#-tiếng-việt)

</div>

---

ChatGPT Local Coder is a **self-hosted MCP server** that turns ChatGPT — or any
MCP client — into a coding agent on your own machine: read and edit code, run
`npm test`, manage git, apply unified diffs, explore with `glob` / `grep`, run
installed skills, and hand work to another local CLI.

One Node process. No desktop app, no container, no vendor lock-in. **Native
Windows, macOS and Linux** — not WSL, not Docker.

```
┌─────────────────┐     HTTPS      ┌──────────────────┐    127.0.0.1     ┌──────────────────────┐
│   ChatGPT Web   │ ─────────────► │  Tunnel (opt.)   │ ───────────────► │  chatgpt-local-coder │
│ Developer Mode  │                │ OpenAI / CF      │      :3000/mcp   │  53 MCP tools        │
└─────────────────┘                └──────────────────┘                  └──────────┬───────────┘
                                                                                    │
                     ┌───────────────┬──────────────┬────────────────┬──────────────┤
                     ▼               ▼              ▼                ▼              ▼
                 Filesystem      Shell + Git     Skills          Delegates      Settings
                 scoped writes   host-user       ~/.chatgpt-     claude/codex   imported from
                 to workspace    privileges      local-coder     opencode/grok  other agents
```

## 🚀 Quick Start

**Requirements:** [Node.js](https://nodejs.org) 20+, npm. Git is optional and
only needed for the `git_*` tools.

> **Not on the npm registry yet.** Install from a clone until it is published;
> `npm i -g chatgpt-local-coder` will fail with `404 Not Found`.

```bash
git clone https://github.com/hoanganhduc/chatgpt-local-coder.git
cd chatgpt-local-coder
npm install
npm run build
npm link                      # puts `chatgpt-local-coder` and `clc` on PATH

chatgpt-local-coder init --workspace /path/to/your/project
chatgpt-local-coder doctor
chatgpt-local-coder up
```

The last three commands are identical on all three operating systems. On
Windows, `--workspace C:\Users\You\projects\my-app`; everything else is the
same, because the CLI resolves per-OS config, state and cache directories for
you.

`npm link` symlinks the repo, so a later `npm run build` takes effect without
reinstalling. `npm i -g .` installs a copy instead. Undo either with
`npm unlink -g chatgpt-local-coder`. If you would rather not touch the global
bin directory at all, every command below also works as
`node dist/cli/main.js <command>` from the repo.

- `init` writes the config file. Add `--interactive` to be prompted for anything
  you did not pass as a flag, or `--force` to overwrite instead of merge.
- `doctor` reports what would stop the host from working, and exits non-zero if
  anything is at `error` level — warnings alone still exit 0. It checks the Node
  version, the config file, the workspace roots, both ports, the tunnel binary,
  detected delegate CLIs, imported settings, discovered skills, and which secrets
  are `set` or `unset` — never a secret value. `--json` gives the same report to
  a script.
- `config path` prints the resolved config, state and cache directories.
  `doctor` names only the config file.
- `up` runs the server in the foreground and connects the tunnel unless you pass
  `--no-tunnel`.

Health check: `http://127.0.0.1:3000/health`.

The admin UI needs a token, so a bare `http://127.0.0.1:3001/ui` answers `401`.
Open the tokenised URL from the startup banner instead. When `ADMIN_TOKEN` is
unset the host invents a token for that run: started from a terminal the banner
prints the whole URL, and started as a service it prints the path to a
private file holding it, because the banner would otherwise put the token in the
system journal. Set `ADMIN_TOKEN` to keep one token across restarts and to
authenticate scripts with `Authorization: Bearer <token>`.

<details>
<summary><b>Add skills from <code>ai-agents-skills</code> (optional)</b></summary>

Skills are discovered from several roots, so the host works without this. To
install into the host's own agent home:

```bash
mkdir -p ~/.chatgpt-local-coder
cd ~/ai-agents-skills
python3 -m installer.ai_agents_skills --agents chatgpt-local-coder \
  install --skills sagemath,zotero            # dry run: prints, writes nothing

AAS_INSTALL_CONFIRM="I understand the installation and uninstall process" \
python3 -m installer.ai_agents_skills --agents chatgpt-local-coder \
  install --apply --real-system --skills sagemath,zotero
```

`install` is a dry run by default. Applying needs `--apply`, the confirmation
variable, and `--real-system` for writes to a real home directory. Check it with
`… --agents chatgpt-local-coder verify`, and undo it with `… uninstall`.

</details>

<details>
<summary><b>Run it in the background instead of the foreground</b></summary>

```bash
chatgpt-local-coder service install     # systemd user unit / LaunchAgent / schtasks logon task
chatgpt-local-coder service status
chatgpt-local-coder tunnel connect      # the service does not manage the tunnel
```

No elevation is required on any of the three platforms. See
[docs/cross-platform.md](docs/cross-platform.md#4-background-service) for what
each mechanism does and does not survive.

</details>

## 🔐 Permissions

The default profile is **`workspace`**, not full disk access.

| Profile | Read | Write | Shell commands |
|---|---|---|---|
| **`workspace`** *(default)* | anywhere except the host's config directory | workspace roots only | allowed |
| `open` | anywhere except the host's config directory | anywhere except the host's config directory | allowed |
| `readonly` | anywhere except the host's config directory | denied | denied |

The host's own config directory is denied to every profile, `open` included, in
both directions. It holds `secrets.json` and the reference files the tunnel
runtime starts from, so a tool that could read it would let a connected model
print the key authorizing the tunnel back over that same tunnel. Use
`chatgpt-local-coder secrets` to check a credential instead.

Widen or narrow it either way:

```bash
chatgpt-local-coder config set permissionProfile open     # persistent
chatgpt-local-coder up --profile open                     # this run only
chatgpt-local-coder init --workspace A --workspace B      # more roots, same profile
```

> **Approved shell commands run with full host-user privileges.** The
> `workspace` profile scopes *file tools*. It does not sandbox `run_command`:
> once a command is approved, `npm`, `python`, or a subshell it starts can reach
> anything your user account can reach. There is no seccomp, Job Object, or
> sandbox-exec layer here. Treat `workspace` as a guardrail against an agent's
> mistakes, not as a security boundary against a hostile one.

> **Delegate CLIs are not governed by this profile either.** When
> `agent_delegate` invokes `claude`, `codex`, `opencode` or `grok`, that CLI runs
> as your user under its own configuration. Restricting `cwd` bounds where the
> delegate's work starts, not what it may touch.

The MCP listener binds `127.0.0.1` unless you explicitly override `bindHost`.
Expose it to the internet only through a tunnel you control.

## 🔌 Connect ChatGPT

### 1. Enable Developer Mode

In ChatGPT, open **Settings → Connectors** and enable **Developer mode** under
the advanced options.

> **This UI path is version-sensitive.** OpenAI has moved it between *Settings →
> Connectors → Advanced* and *Settings → Apps & Connectors → Advanced*, and
> availability depends on your plan tier. If it is not where this says, follow
> the [official Developer Mode guide](https://developers.openai.com/api/docs/guides/developer-mode),
> which is the authority — not this README.

### 2. Expose the server

```bash
chatgpt-local-coder tunnel init      # download + verify tunnel-client, create the alias
chatgpt-local-coder tunnel connect   # start the supervised runtime
chatgpt-local-coder tunnel status
```

`tunnel init` resolves a `tunnel-client` binary from `tunnel.binPath`, the
cache, or `PATH` before downloading anything; a download is verified against the
release `SHA256SUMS.txt` before it is unpacked.

> `tunnel connect` **starts a managed background runtime as a side effect.** Do
> not run it just to read its help — use `chatgpt-local-coder tunnel --help`.

Tunnel credentials come from
[OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)
and [→ API keys](https://platform.openai.com/settings/organization/api-keys).
Store them as secrets, not as literals on a command line:

```bash
chatgpt-local-coder secrets set OPENAI_TUNNEL_ID
chatgpt-local-coder secrets set OPENAI_TUNNEL_API_KEY
chatgpt-local-coder secrets list                   # names and sources, never values
```

`tunnel init` and `tunnel connect` pick them up on their own. See
[docs/credentials.md](docs/credentials.md) for what each credential is, the
permissions it needs, and how to obtain it step by step.

Cloudflare Quick Tunnel still works as a free alternative
(`cloudflared tunnel --url http://localhost:3000`), but its URL changes on every
restart, so the connector needs re-wiring each time.

### 3. Create the connector

**Settings → Connectors → Create**, then:

| Field | Value |
|-------|-------|
| **Name** | `Local Coder` |
| **Description** | `Local coding agent. First call agent_status + project_context. Use glob/grep to explore, apply_patch to edit, run_command for shell.` |
| **URL** | Your tunnel HTTPS URL, or the `tunnel_…` ID under **Connection type → Tunnel** |
| **Authentication** | None |

### 4. Tag the connector in every chat

Every message that should use local tools **must include the connector**. If you
skip this, ChatGPT uses only its built-in tools, shows *"Looking for available
tools"*, then **"Error in message stream"** — with **no server log at all**,
because the MCP server was never called.

Two ways to tag:

1. **New chat → `+` (tools) → More → enable Local Coder** — stays on for that chat.
2. Type **`@`** in the message and pick the connector so it appears as a chip.

> After a server update or restart: **Refresh** the connector and start a **new
> chat**. Avoid clicking **"Always allow"** on permission popups — it can reset
> the MCP session. Configure permissions in **Settings → Apps** instead.

## 🧰 Tools

**53 tools** in the `full` profile, **30** in the default `slim` profile, all
returning structured JSON `{ ok, tool, summary, data }`. Switch with
`chatgpt-local-coder up --tool-profile full`.

The tables below list all 53. The default `slim` profile exposes only these 30 —
anything else returns `Tool not found` until you switch to `full`:

```
agent_delegate  agent_status     apply_patch      clear_processes  edit_file
git_add         git_commit       git_diff         git_restore      git_status
glob            grep             list_directory   load_path_rules  mcp_servers
multi_edit      process_output   process_status   project_context  read_text_file
remember        rewind           run_command      shell_status     skill_list
skill_read      skill_run        start_process    stop_process     write_file
```

### Onboarding *(call these first)*

| Tool | Description |
|------|-------------|
| `agent_status` | Active profile, workspace roots, audit log |
| `project_context` | Reads AGENTS.md, README, CLAUDE.md, configs |

### Filesystem

| Tool | Description |
|------|-------------|
| `read_text_file` | Read source files (offset + limit) |
| `write_file` | Create or overwrite files |
| `edit_file` / `multi_edit` | Find-and-replace edits, one or many |
| `replace_regex` | Regex replace in file |
| `apply_patch` | Unified / Codex-style patches |
| `glob` / `grep` / `search_files` | Find by name, by content, or both |
| `list_directory` / `directory_tree` | List or walk a folder |
| `create_directory` | Create folders |
| `delete_file` / `delete_directory` | Remove files or dirs |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |
| `list_allowed_directories` / `load_path_rules` | Inspect the active path scope |
| `rewind` | Undo file edits through automatic checkpoints |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run shell commands (`npm test`, builds, …) |
| `shell_status` / `shell_reset` | Persistent shell session |
| `start_process` | Long-running / background commands |
| `process_status` / `process_output` / `stop_process` / `clear_processes` | Manage background jobs |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch |
| `git_restore` | Restore tracked files to last commit |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and reset |

### Host

| Tool | Description |
|------|-------------|
| `skill_list` / `skill_read` / `skill_run` | Discover, read and run installed skills |
| `agent_delegate` / `delegate_status` | Hand a task to another local CLI |
| `settings_status` | What was imported from other agents, and which source won |
| `mcp_servers` / `mcp_tools` / `mcp_call` | Proxy another MCP server on this machine |
| `remember` | Append to the project memory file |

### Claude Code ↔ MCP mapping

| Claude Code | This server |
|-------------|-------------|
| `Read` | `read_text_file` |
| `Write` | `write_file` |
| `Edit` / `MultiEdit` | `edit_file` / `multi_edit` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `list_directory` |
| `Bash` | `run_command` |
| `Task` / subagent | `agent_delegate` |
| `Skill` | `skill_run` |
| — | `apply_patch`, `git_*`, `project_context`, `rewind`, `mcp_*` |

## 🧩 Skills

Skills are `SKILL.md` files with frontmatter. Install them with
[`ai-agents-skills`](https://github.com/hoanganhduc/ai-agents-skills), which has
a `chatgpt-local-coder` target:

```bash
python3 -m installer.ai_agents_skills --agent chatgpt-local-coder plan --skills sagemath

AAS_INSTALL_CONFIRM="I understand the installation and uninstall process" \
python3 -m installer.ai_agents_skills --agent chatgpt-local-coder \
  install --apply --real-system --skills sagemath
```

`install` is a dry run unless you pass `--apply`, and applying to a real home
directory needs both the confirmation variable and `--real-system`. Without
them the installer writes nothing.

That writes `~/.chatgpt-local-coder/skills/<name>/SKILL.md` plus a managed block
in `~/.chatgpt-local-coder/AGENTS.md`, which the host loads as user-level memory.

```bash
chatgpt-local-coder skills list
chatgpt-local-coder skills read sagemath
chatgpt-local-coder skills run sagemath -- --help
```

The host also reads skills installed for other agents. Roots are searched in a
fixed order and the first root to define a `name` wins, so a project-local skill
shadows a global one — see
[docs/cross-platform.md](docs/cross-platform.md#6-skills-and-symlinks) for the
full precedence list.

## ⚙️ Configuration

`chatgpt-local-coder config path` prints where `config.json` lives on this OS.
A project may also carry `.chatgpt-local-coder.json` in its root, which layers
over the user config for that workspace.

| Key | Default | Description |
|---|---|---|
| `workspaceRoots` | `[cwd]` | Roots the host may write in under the `workspace` profile |
| `permissionProfile` | `workspace` | `workspace`, `open`, or `readonly` |
| `bindHost` | `127.0.0.1` | Listener address. Change only if you know why |
| `port` / `adminPort` | `3000` / `3001` | MCP and admin ports |
| `toolProfile` | `slim` | `slim` (30 tools) or `full` (53) |
| `shellTimeoutSec` | `120` | Cap for `run_command` |
| `skills.allowExecution` | `true` | Whether `skill_run` may execute |
| `skills.maxRuntimeSec` | `300` | Cap for `skill_run` |
| `settings.import` | `true` | Import settings from other agents |
| `settings.sources` | `codex, grok, opencode, claude` | Which to read, lowest precedence first |
| `delegates.enabled` | `true` | Whether `agent_delegate` may run |
| `delegates.order` | `claude, codex, opencode, grok` | CLI preference order |
| `tunnel.alias` | `chatgpt-local-coder` | tunnel-client runtime alias |

```bash
chatgpt-local-coder config get permissionProfile
chatgpt-local-coder config set port 4000
chatgpt-local-coder config set skills.allowExecution false
```

Environment overrides exist for the settings most often changed per-run:
`CLC_CONFIG_DIR`, `CLC_STATE_DIR`, `CLC_CACHE_DIR`, `CLC_PERMISSION_PROFILE`,
`CLC_BIND_HOST`, `CLC_SHELL`, `CLC_SKILL_ROOTS`, `CLC_SKILL_EXECUTION`,
`CLC_SETTINGS_IMPORT`, `CLC_DELEGATES`, `CLC_HOOKS`, `CLC_TUNNEL_ALIAS`,
`CLC_TUNNEL_BIN`, `PORT`, `ADMIN_PORT`, `WORKSPACE_PATH`,
`CHATGPT_TOOL_PROFILE`, `ADMIN_TOKEN`, `CLC_ALLOWED_ORIGINS`, `AUDIT_LOG_PATH`.
This is a selection, not the whole surface — the checkpoint, session and memory
knobs are read from the environment too, and they are documented where they are
used rather than here.

`WORKSPACE_PATH` takes a list. The separator is `;` on Windows and either `:` or
`;` on macOS and Linux — see
[docs/cross-platform.md](docs/cross-platform.md#1-where-files-live).

`ADMIN_TOKEN` fixes the admin token instead of letting the host generate one per
run. `CLC_ALLOWED_ORIGINS` is a comma-separated list of browser origins allowed
to call the MCP listener; with it unset no origin is allowed, which is what stops
a page you merely have open from driving the host. Neither affects a caller that
sends no `Origin`, such as the tunnel client.

### Imported settings

The host reads `~/.claude/settings.json`, `~/.codex/config.toml` and the Grok
and OpenCode equivalents. **It never writes them.** Two rules hold without
exception:

- Imported `permissions.deny` entries are **always** enforced.
- Imported `permissions.allow` entries **never widen** the host profile. They
  only reduce prompting inside what the profile already permits.

`chatgpt-local-coder settings show` lists every source, what it contributed, and
which one won each key.

### Secrets

Secrets are read from the environment first and from `secrets.json` in the
config dir second. The file is created `0600`, and on Windows its DACL is
restricted to your account. Values are never logged; `doctor` prints only `set`
or `unset`.

```bash
chatgpt-local-coder secrets set OPENAI_TUNNEL_API_KEY   # hidden prompt; never an argument
chatgpt-local-coder secrets list                        # names and sources
chatgpt-local-coder secrets delete NAME
chatgpt-local-coder secrets path
```

`scripts/set-secrets.sh` does the same without the CLI installed. Full guide:
[docs/credentials.md](docs/credentials.md).

## 🏗️ Architecture

```
src/
├── index.ts             # Express + MCP session manager
├── server-factory.ts    # Tool registration
├── admin/               # admin server, token guard, admin API routes
├── cli/                 # init, doctor, up/down/status, secrets, tunnel, service, skills, settings, config
├── config/              # per-OS paths, layered load, zod schema
├── hooks/               # pre/post tool-call hook dispatch
├── lib/                 # platform adapter, permissions, patch, shell, secrets, memory
├── skills/              # discovery, frontmatter, registry, execution
├── settings/            # read-only adapters for claude/codex/grok/opencode
├── delegates/           # local CLI fork backends
├── services/            # systemd user unit, LaunchAgent, schtasks task
├── tunnel/              # release resolution, verification, runtime supervision
└── tools/               # filesystem, shell, git, context, host
```

- **Transport:** MCP Streamable HTTP (`/mcp` and `/`)
- **Session:** stateful, with auto-recovery when a client holds a stale session ID
- **Output:** structured JSON from every tool

## 🧪 Development

```bash
npm run build       # compile TypeScript
npm run test:all    # build + unit + server-level + integration suites
npm test            # unit suites only
npm run dev         # watch mode (tsx)
```

CI runs `npm ci`, `npm run build` and `npm run test:all` on `ubuntu-latest`,
`windows-latest` and `macos-latest` against Node 20 and 22. No job reaches the
network except `npm ci`.

## 🔒 Security

- The listener binds `127.0.0.1` by default. Expose it only through a tunnel you control.
- Default writes are scoped to the workspace roots — but **approved shell
  commands and delegate CLIs are not sandboxed**. See [Permissions](#-permissions).
- Secrets live in a `0600` file outside the repo, or in the environment. Never in `config.json`.
- The tunnel manager passes credentials only as `env:NAME` or `file:/path`
  references, never as literal key material on a command line.
- The admin API and UI both require a token, and the listener is loopback-only.
  No browser origin may call the MCP listener unless you name it in
  `CLC_ALLOWED_ORIGINS`.
- Audit log: `.mcp-audit.log` in the server's working directory, or wherever
  `AUDIT_LOG_PATH` points. It is **always** written, with ordinary file
  permissions, and it records the full command line of every `run_command` —
  keep it out of version control and off shared storage, and pass credentials to
  commands through the environment rather than inline.
- Use on a machine and network you trust.

## 🩺 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Error in message stream"** right after *"Looking for tools"* — **no server log** | You did not tag the connector. New chat → **+** → **More** → enable it, or type **`@Local Coder`**. |
| **Access denied** on a write | Expected under the `workspace` profile if the path is outside your roots. Add a root with `init --workspace`, or switch profile. |
| **Access denied** on a path inside the config directory | Separate rule, and not something a profile change lifts: the host's config directory is denied for reads as well as writes in **every** profile, `open` included, because it holds `secrets.json`. Use `chatgpt-local-coder secrets` instead. |
| **A tool is denied and names an imported rule** | A `permissions.deny` entry in another agent's settings matched. Remove it there, or set `settings.import` to `false`. |
| **Resource not found** on a tool call | Refresh the connector and start a new chat. Sessions auto-recover; make sure the latest build is running. |
| **Connection failed** | `chatgpt-local-coder status` — server and tunnel must both be up, and the URL must be HTTPS. |
| **Permission popup on every call** | Settings → Apps → set the connector to *Ask before important changes*. Do not use the popup's "Always allow". |
| **Tool blocked by OpenAI safety** | Not a server bug. Retry via `run_command`; responses may include a `run_command_fallback`. Affects `git_push`, `git_checkout`, `delete_directory` occasionally. |
| **`stream canceled` in the tunnel log** | Server or tunnel restarted mid-session. Refresh the connector, new chat. |
| **Tunnel URL keeps changing** | Use the OpenAI Secure Tunnel (`tunnel init` / `tunnel connect`) instead of a Cloudflare quick tunnel. |
| **A command works on one OS, not another** | Shells differ per platform and the host does not translate. See [docs/cross-platform.md](docs/cross-platform.md#2-shell-selection). |
| **`run_command` output ends in `[output truncated at 2000000 bytes]`** | A command may print at most 2,000,000 bytes; the rest is dropped and the result is flagged `truncated`. Redirect to a file and read it in pieces. |
| **`run_command` returns while the job keeps running** | Expected: a command that exits while leaving something running (`npm run dev &`) is answered when *it* exits. Use `start_process` for a job you want to manage. |
| **A `git_*` tool reports a timeout** | A git subcommand gets 2 minutes, and the session-start snapshot 15 seconds. A `pre-commit` hook that runs a test suite is the usual cause — run that through `run_command`, which reports progress and has its own cap. |
| **git not found** | Install [Git](https://git-scm.com). Everything except the `git_*` tools works without it. |

`chatgpt-local-coder doctor` diagnoses most of the above in one command. See also
[AGENTS.md](AGENTS.md) for agent onboarding and the `apply_patch` format.

## 📚 References

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ai-agents-skills](https://github.com/hoanganhduc/ai-agents-skills)

## 📄 License

[MIT](LICENSE) — use, modify, and redistribute freely, including commercially.
The one condition is that the copyright and permission notices travel with any
copy or substantial portion.

Forked from [hoangcoderr/chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder)
and developed further here. The original copyright notice is retained in
[LICENSE](LICENSE) alongside this fork's, as MIT requires.

## ⭐ Support

If this saves you time, **star the repo** — it helps others find it.

---

## 🇻🇳 Tiếng Việt

**ChatGPT Local Coder** biến ChatGPT web thành agent code trên máy bạn qua MCP.
Chạy native trên **Windows, macOS và Linux** — không cần WSL hay Docker.

> **Chưa có trên npm registry.** Cài từ clone; `npm i -g chatgpt-local-coder` sẽ
> báo `404 Not Found`.

```bash
git clone https://github.com/hoanganhduc/chatgpt-local-coder.git
cd chatgpt-local-coder
npm install
npm run build
npm link                      # đưa `chatgpt-local-coder` và `clc` vào PATH

chatgpt-local-coder init --workspace /duong/dan/project
chatgpt-local-coder doctor
chatgpt-local-coder up
```

Trên Windows dùng `--workspace C:\Users\Ban\projects\my-app`. Ba lệnh cuối
giống hệt nhau trên cả ba hệ điều hành. Gỡ link: `npm unlink -g
chatgpt-local-coder`.

**Quyền mặc định là `workspace`, không phải full disk.** Đọc file ở hầu hết mọi
nơi, nhưng **ghi** chỉ trong các workspace root. Muốn mở rộng:
`chatgpt-local-coder config set permissionProfile open`.

Ngoại lệ duy nhất, áp dụng cho **mọi** profile kể cả `open`: thư mục config của
host bị chặn cả đọc lẫn ghi, vì nó chứa `secrets.json`. Dùng
`chatgpt-local-coder secrets` để kiểm tra credential.

Admin UI cần token: mở `http://127.0.0.1:3001/ui` trống sẽ nhận `401`. Hãy mở
URL có token mà server in ra lúc khởi động, hoặc đặt `ADMIN_TOKEN` để dùng một
token cố định.

> **Lưu ý quan trọng:** lệnh shell đã được duyệt chạy với **toàn quyền của user**
> trên máy. Profile `workspace` chỉ giới hạn các tool file, **không** sandbox
> `run_command`. Các delegate CLI (`claude`, `codex`, …) cũng không bị profile
> này quản lý.

**ChatGPT:** Settings → Connectors → bật **Developer mode** → tạo connector →
chọn tunnel → Refresh → mở chat mới. Vị trí Developer mode trong giao diện
ChatGPT có thể thay đổi theo phiên bản và gói tài khoản; nếu không thấy, xem
[hướng dẫn chính thức](https://developers.openai.com/api/docs/guides/developer-mode).

**Bắt buộc tag connector mỗi chat:** Chat mới → **+** → **More** → bật connector,
hoặc gõ **`@`** + tên connector. Nếu không tag, ChatGPT báo *"Đang tìm các công
cụ có sẵn"* rồi *"Lỗi trong luồng tin nhắn"* — **server không có log** vì MCP
chưa hề được gọi.

**Không bấm "Luôn cho phép"** trên popup — nó thường đóng MCP session. Cấu hình
quyền ở Settings → Apps thay vào đó.

Chẩn đoán nhanh: `chatgpt-local-coder doctor`.
Chi tiết cho AI agent: [AGENTS.md](AGENTS.md).
Khác biệt giữa các hệ điều hành: [docs/cross-platform.md](docs/cross-platform.md).
