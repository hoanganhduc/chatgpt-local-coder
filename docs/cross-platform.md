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
