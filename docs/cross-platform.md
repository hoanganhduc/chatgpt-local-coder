# Cross-platform reference

Native Windows, Linux and macOS are release requirements. Nothing here needs
WSL, Docker, or a POSIX emulation layer. Where behaviour genuinely differs by
operating system, this page says so instead of assuming one of the three.

Everything that knows about an OS difference lives in `src/lib/platform.ts` and
`src/config/paths.ts`. If you are adding a feature and find yourself writing
`process.platform` anywhere else, put it in the adapter instead.

---

## 1. Where files live

| Purpose | Windows | macOS | Linux |
|---|---|---|---|
| Config dir | `%APPDATA%\chatgpt-local-coder` | `~/Library/Application Support/chatgpt-local-coder` | `$XDG_CONFIG_HOME/chatgpt-local-coder`, default `~/.config/chatgpt-local-coder` |
| State dir | `%LOCALAPPDATA%\chatgpt-local-coder\state` | `~/Library/Application Support/chatgpt-local-coder/state` | `$XDG_STATE_HOME/chatgpt-local-coder`, default `~/.local/state/chatgpt-local-coder` |
| Cache dir | `%LOCALAPPDATA%\chatgpt-local-coder\cache` | `~/Library/Caches/chatgpt-local-coder` | `$XDG_CACHE_HOME/chatgpt-local-coder`, default `~/.cache/chatgpt-local-coder` |
| Config file | `<config dir>\config.json` | `<config dir>/config.json` | `<config dir>/config.json` |
| Secret store | `<config dir>\secrets.json` | `<config dir>/secrets.json` | `<config dir>/secrets.json` |
| Agent home | `%USERPROFILE%\.chatgpt-local-coder` | `~/.chatgpt-local-coder` | `~/.chatgpt-local-coder` |

`CLC_CONFIG_DIR`, `CLC_STATE_DIR` and `CLC_CACHE_DIR` override the first three
on every OS. Run `chatgpt-local-coder doctor` to print the resolved paths for
the machine you are actually on.

The **agent home** is separate from the config dir on purpose. It is the
directory `ai-agents-skills` installs into; the host reads it and never writes
it, and the installer writes it and never touches the config dir or the secret
store.

A project may also carry `.chatgpt-local-coder.json` in its root. It layers over
the user config for that workspace.

---

## 2. Shell selection

`run_command` and skill execution use one shell per OS, chosen in this order:

1. `CLC_SHELL`, if set — an absolute path or a bare name. A basename matching
   `pwsh` or `powershell` is invoked with PowerShell argument conventions;
   anything else is invoked as a POSIX shell.
2. **Windows:** `pwsh` when it is on `PATH`, otherwise `powershell.exe`, each
   run as `-NoProfile -NonInteractive -Command <script>`.
3. **macOS:** `$SHELL` when it is `zsh`, `bash` or `sh`; otherwise `/bin/zsh`.
4. **Linux:** `$SHELL` when it is `bash`, `zsh` or `sh`; otherwise `/bin/sh`.

POSIX shells are invoked as `-lc <script>`.

The practical consequence: a command you write for one host is not portable to
the other two. `rm -rf build` works on macOS and Linux; the Windows equivalent
is `Remove-Item -Recurse -Force build`. The host does not translate commands,
and it should not — silently rewriting a shell command is worse than failing.

---

## 3. Path handling

Path comparison is case-insensitive on Windows and macOS and case-sensitive on
Linux. The permission engine uses that rule when it decides whether a path falls
inside a workspace root, so `C:\Users\You\Proj` and `c:\users\you\proj` are the
same root on Windows and `/home/you/Proj` and `/home/you/proj` are two different
roots on Linux.

Workspace roots are resolved to absolute paths and de-duplicated at load time.
Relative paths passed to tools resolve against the first workspace root.

### Symlinked system directories on macOS

macOS resolves `/tmp`, `/var` and `/etc` to `/private/tmp`, `/private/var` and
`/private/etc`. `os.tmpdir()` therefore returns a path under `/var/folders/…`
while a process started there reports `/private/var/folders/…` from
`process.cwd()`, because `getcwd(3)` returns the canonical form.

The two forms are the same directory, and the permission engine treats them as
such: it resolves both the target and the roots before deciding. But a *lexical*
comparison of the two strings fails. Anything comparing paths for equality — a
test fixture, a cache key — has to canonicalise first. Linux has no equivalent,
so this is invisible until it reaches a macOS runner.

### Executable lookup on Windows

`which()` follows Windows rules rather than POSIX ones. A bare name is tried
with each `PATHEXT` extension appended, so `which("node")` finds `node.exe`; a
name that already carries a `PATHEXT` extension is tried as written first, so
`which("node.exe")` finds `node.exe` and not `node.exe.exe`.

The access check cannot carry the weight it does on POSIX:
`fs.constants.X_OK` "has no effect on Windows (will behave like
`fs.constants.F_OK`)", so it is the extension list, not the file mode, that
decides whether a match counts as executable.

### Batch files on Windows

An npm-installed CLI is a `.cmd` shim on Windows, so every delegate — `claude`,
`codex`, `grok`, `opencode` — resolves to a batch file there and to an ordinary
executable on macOS and Linux. Windows cannot start a batch file directly: only
cmd.exe can read one, and since the CVE-2024-27980 fix (Node 18.20.2 / 20.12.2)
`child_process.spawn` refuses a `.bat`/`.cmd` target with `EINVAL` unless a shell
is asked for. Before this was handled, `runExecutable` caught that throw and
returned an empty result with a null exit code, which is what the Windows CI jobs
were reporting.

`shell: true` is not the answer. It joins argv into one string and hands it to
cmd.exe unquoted, so any `& | < > ^ " %` in an argument becomes cmd.exe syntax.
`runExecutable` instead spawns cmd.exe itself, with
`windowsVerbatimArguments: true` and a command line quoted by
`windowsBatchInvocation` in `src/lib/platform.ts`. That quoting satisfies both
parsers that read the line — cmd.exe first, then the child's C runtime — and it
follows the Rust standard library's rule for the same problem: `"` is doubled,
a run of backslashes is doubled before a quote and before the closing quote, and
`%` is written `%%cd:~,%`, which cmd.exe expands to nothing so no variable
expansion survives. CR, LF and `0x1A` end a cmd.exe command wherever they appear
and cannot be quoted at all, so an argument containing one is refused with an
error rather than encoded.

Where possible the quoting is a second line of defence rather than the first,
because the prompt is kept off the command line entirely — see `promptVia` in
`src/delegates/registry.ts`:

| Delegate | Prompt channel | Why |
|---|---|---|
| `claude` | stdin | `-p` is a flag; with no operand the CLI reads stdin |
| `codex` | stdin | `codex exec -` reads instructions from stdin |
| `grok` | `0600` temp file | no stdin prompt mode; `--prompt-file <path>` takes a path |
| `opencode` | argv | takes the message as an operand and offers neither channel |

`opencode` is the exception, and it carries a Windows-only limitation as a
result: because CR and LF cannot be encoded into a cmd.exe command line at all,
a **multi-line prompt to `opencode` is refused on Windows**. It is reported as a
failed delegation naming the cause, not silently truncated — a truncated command
line would run its tail unquoted, which is the injection this all exists to
prevent. The other three delegates take multi-line prompts on every OS, so
prefer them on Windows, or keep an `opencode` prompt to a single line.

A delegate that never starts is now reported as a failure rather than as a
success with empty output (`spawnFailed` on `RunResult`). The two are
indistinguishable otherwise — both are a null exit code and an empty stdout —
and treating the first as the second is precisely what kept the Windows defect
invisible while `agent_delegate` reported `ok: true`.

`windowsBatchInvocation` is exported and exercised by `scripts/test-platform.mjs`
on every OS, because a Linux or macOS developer cannot otherwise reproduce any
of this. `scripts/test-platform.mjs` additionally runs a real npm-shaped `.cmd`
shim end to end on Windows, with a canary file that a leaked separator would
create.

---

## 4. Background service

`chatgpt-local-coder service install` installs a **per-user** service. None of
the three implementations needs elevation, and none of them manages the tunnel —
run `chatgpt-local-coder tunnel connect` separately, or use `up`, which does both
in the foreground.

| OS | Mechanism | Notes |
|---|---|---|
| Linux | systemd **user** unit | Needs a user session bus. Survives logout only when lingering is enabled (`loginctl enable-linger $USER`). |
| macOS | LaunchAgent in `~/Library/LaunchAgents` | Starts at login. |
| Windows | `schtasks` logon task | Starts at logon. No service-account install, so nothing runs before you log in. |

`service install --dry-run` prints the generated unit without installing it, and
`--platform <win32\|darwin\|linux>` generates another platform's unit (implying
`--dry-run`) so you can inspect all three from one machine.

---

## 5. Secrets

Secrets are read from `process.env[NAME]` first and from
`<config dir>/secrets.json` second, so an environment variable always wins over
the stored file. The file is created with mode `0600`; on Windows the host
additionally restricts the DACL with
`icacls <file> /inheritance:r /grant:r <user>:F`.

The host knows three names: `OPENAI_TUNNEL_API_KEY`, `OPENAI_TUNNEL_ID` and
`ADMIN_TOKEN`. `doctor` reports each as `set` or `unset` with its source, and
never prints a value. No secret value appears in any log, tool output or doctor
report — that is a release gate, not a preference.

When the tunnel manager passes credentials to `tunnel-client`, it passes only
reference forms: `--runtime-api-key env:NAME` or `--runtime-api-key file:/path`.
Literal key material is never placed on a command line, where it would be
visible to every other process on the machine.

---

## 6. Skills and symlinks

`ai-agents-skills` installs skills into `~/.chatgpt-local-coder/skills/<name>/SKILL.md`
in **copy** mode on every OS. Copying rather than symlinking is deliberate:
creating a symlink on native Windows is privilege-gated (Developer Mode or
`SeCreateSymbolicLinkPrivilege`), so a symlink-first install would work on two of
the three required platforms and fail on the third.

Skill discovery roots, in precedence order — the first root to define a given
skill `name` wins:

1. `<workspace>/.agents/skills`
2. `<workspace>/.claude/skills`
3. `$AI_AGENTS_SKILLS_HOME`
4. `~/.claude/skills`
5. `~/.chatgpt-local-coder/skills`
6. `~/.codex/skills`
7. `~/ai-agents-skills/canonical/skills`
8. extra roots from `skills.roots` in the host config

`chatgpt-local-coder skills list --json` shows which root each skill came from
and what was shadowed.

---

## 7. Tunnel binary

`chatgpt-local-coder tunnel init` resolves a `tunnel-client` binary in this
order: `tunnel.binPath` from the config (set it with `CLC_TUNNEL_BIN`), then the
newest copy already in the cache dir, then `tunnel-client` on `PATH`, and only
then a download.

A download reads `openai/tunnel-client` `releases/latest` rather than pinning a
version, picks the asset named
`tunnel-client-<version>-<windows|darwin|linux>-<amd64|arm64>.zip`, checks it
against the release's `SHA256SUMS.txt` **before** unpacking, and unpacks
`tunnel-client` — `tunnel-client.exe` on Windows — into
`<cache dir>/tunnel-client/<version>/`.

`tunnel connect` **starts a managed background runtime as a side effect.** Do
not run it to look at its help output; run `chatgpt-local-coder tunnel --help`
instead.

---

## 8. What is not sandboxed

Two boundaries are worth stating plainly, because the defaults can read as
stronger than they are.

**Approved shell commands run with full host-user privileges.** The `workspace`
profile scopes *file tools* to the workspace roots. It does not sandbox
`run_command`. Once a command is approved, `npm`, `python`, or a subshell it
starts can reach anything your user account can reach, on any OS. There is no
seccomp, Job Object, or sandbox-exec layer here.

**Delegate CLIs are not governed by this host's permission profile.** When
`agent_delegate` invokes `claude`, `codex`, `opencode` or `grok`, that CLI runs
as the host user under its own configuration. Restricting `cwd` bounds where the
delegate's work *starts*, not what it may touch.

---

## 9. CI

`.github/workflows/ci.yml` builds and tests on `ubuntu-latest`,
`windows-latest` and `macos-latest` against Node 20 and Node 22 — six jobs, with
`fail-fast: false` so one platform's failure does not mask the others.

Steps are `npm ci`, `npm run build`, `npm run test:all`. No job reaches the
network except `npm ci`: the tunnel tests use `example.invalid` release
payloads, the delegate tests use stub executables, and the MCP tests spawn local
servers on `127.0.0.1`.
