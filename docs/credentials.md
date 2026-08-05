# Credentials

Everything the host needs, how to obtain each value, and how to store it.
Nothing here is required to run locally — credentials matter only when you
expose the host to ChatGPT through a tunnel.

## What the host uses

| Name | What it is | Where it comes from |
|---|---|---|
| `OPENAI_TUNNEL_ID` | Which tunnel to attach to | [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels) |
| `OPENAI_TUNNEL_API_KEY` | Runtime key the tunnel daemon authenticates with | [Platform → API keys](https://platform.openai.com/settings/organization/api-keys), with **Tunnels Read + Use** |
| `OPENAI_ADMIN_KEY` | Admin key for control-plane writes only | [Platform → Admin keys](https://platform.openai.com/settings/organization/admin-keys) |
| `ADMIN_TOKEN` | Bearer token guarding this host's admin API | You choose it |

All four are read from the environment first, then from `secrets.json`.

`OPENAI_ADMIN_KEY` is used for one step — creating the runtime alias during
`tunnel init` — and is never handed to the long-lived daemon. That split is
tunnel-client's own rule, and the host enforces it: `tunnel connect` passes only
the runtime key.

## Getting each credential

Do these in order. Step 1 produces the tunnel id that steps 2 and 3 attach to.

### Before you start

You need an OpenAI **organization**, not just a personal API key, and the right
permissions on it. From
[Organization → Roles](https://platform.openai.com/settings/organization/people/roles):

| To do this | You need |
|---|---|
| Create or delete tunnels | Tunnels **Read + Manage** |
| Create the runtime API key, and run the daemon | Tunnels **Read + Use** |
| Create an admin key | Platform **admin-key** permission, granted separately |

If the Tunnels page shows nothing and offers no **Create**, you are missing
Tunnels Manage — ask an owner rather than working around it.

### 1. `OPENAI_TUNNEL_ID`

**From the web page.** Open
[Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)
and create a tunnel. You will be asked for a name and description, and for the
organization and/or workspace it is scoped to. Copy the `tunnel_…` identifier it
returns.

**From the CLI**, if you would rather not use the browser. This route needs an
admin key, so do step 3 first. `tunnel init` installs and verifies the binary
before anything else, so it is cached under
`~/.cache/chatgpt-local-coder/tunnel-client/<version>/` even if the alias step
that follows fails for want of a tunnel:

```bash
chatgpt-local-coder tunnel init
~/.cache/chatgpt-local-coder/tunnel-client/*/tunnel-client admin tunnels create \
  --name "Local Coder" \
  --description "Routes to my laptop" \
  --organization-id org_...
```

`--name` and `--description` are both required, and at least one
`--organization-id` or `--workspace-id` must be given. The `org_…` and `ws_…`
identifiers are on your organization and workspace settings pages.

**Either way, wait 25–30 seconds** before using the tunnel. It is not active the
moment `create` returns, and connecting too early looks exactly like a bad
credential.

### 2. `OPENAI_TUNNEL_API_KEY`

Open [Platform → API keys](https://platform.openai.com/settings/organization/api-keys)
and create a key. Two things matter:

- Grant it **Tunnels Read + Use**. A key with the wrong permissions authenticates
  and *then* fails, which reads like a broken tunnel rather than a scope problem.
- The value is shown **once**. Store it before closing the dialog — the next
  section is one command.

This is the only credential the daemon ever sees. Scope it no wider than the
tunnel.

### 3. `OPENAI_ADMIN_KEY`

Needed for control-plane writes: `admin tunnels create|update|delete` above, and
the alias `tunnel init` creates. Without one, `init` installs and verifies the
binary and then stops at `Alias creation failed`.

Create it at
[Platform → Admin keys](https://platform.openai.com/settings/organization/admin-keys).
This is a different page and a different permission from the API keys above; an
ordinary API key will not work for `admin tunnels …` or `runtimes create`.

Treat it as the most sensitive value here: it can create and delete tunnels for
the whole organization. Store it, use it for setup, and consider deleting it
afterwards — the daemon does not need it and will never be given it.

### 4. `ADMIN_TOKEN`

Nobody issues this one; you invent it. It guards this host's own admin API and
web UI, which are bound to localhost.

```bash
openssl rand -hex 32                                  # Linux, macOS
```

```powershell
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)
```

Any long random string works. With no token set, anything that can reach the
admin port can drive the admin API — which matters when other people have
accounts on the machine.

## Storing them

### 1. The built-in command

```bash
chatgpt-local-coder secrets set OPENAI_TUNNEL_API_KEY
chatgpt-local-coder secrets list
```

`set` prompts with the input hidden, trims the trailing newline a paste brings
along, and reports only a character count. It **refuses a value as an
argument** — a command line is readable by any local user through `ps` and
`/proc`, and lands in shell history besides.

```
secrets list            which names are set, and from where. Prints no values.
secrets delete NAME     remove one entry.
secrets path            print the path to secrets.json.
secrets set NAME --stdin   read the value from a pipe, for scripts.
```

### 2. The script

```bash
./scripts/set-secrets.sh
```

Same behaviour, no install required — useful before `npm link`, or on a machine
where you have the checkout but not the CLI on `PATH`. It prompts for each
credential in turn and keeps existing entries unless you choose to replace them.
`--show` and `--delete NAME` mirror `secrets list` and `secrets delete`.

### 3. By hand

```bash
mkdir -p ~/.config/chatgpt-local-coder
cat > ~/.config/chatgpt-local-coder/secrets.json <<'EOF'
{
  "OPENAI_TUNNEL_API_KEY": "sk-...",
  "OPENAI_TUNNEL_ID": "tunnel_..."
}
EOF
chmod 600 ~/.config/chatgpt-local-coder/secrets.json
```

A flat JSON object of string values. Unknown names are preserved but ignored.
Do not forget the `chmod` — writing the file yourself skips the host's own
`0600` creation.

### 4. Environment variables

```bash
export OPENAI_TUNNEL_API_KEY='sk-...'
export OPENAI_TUNNEL_ID='tunnel_...'
```

**The environment always wins over the file.** That is convenient for a one-off
or for CI, and it is also the most common way to lose an hour: a stale export in
one shell silently shadows the value you just stored. `secrets list` reports the
source for exactly this reason.

## Where they are stored

`secrets.json` in the host's config directory, mode `0600`:

| OS | Path |
|---|---|
| Linux | `~/.config/chatgpt-local-coder/secrets.json` |
| macOS | `~/Library/Application Support/chatgpt-local-coder/secrets.json` |
| Windows | `%APPDATA%\chatgpt-local-coder\secrets.json` |

`$CLC_CONFIG_DIR` overrides all three. `chatgpt-local-coder secrets path` prints
the resolved location.

The file is created `0600` *before* any content is written, so a secret is never
briefly world-readable. On Windows the DACL is restricted to your account with
`icacls` instead.

## Verifying

```bash
chatgpt-local-coder doctor
```

```
  ok    OPENAI_TUNNEL_API_KEY=set, OPENAI_TUNNEL_ID=set, ADMIN_TOKEN=unset
```

`doctor` prints `set` or `unset` and never a value. No secret appears in any
log, tool output, or report.

## How credentials reach tunnel-client

They are never passed as literals. The host writes the value to its own `0600`
file under `<config dir>/secret-refs/` and passes a **reference**:

```
--runtime-api-key file:/home/you/.config/chatgpt-local-coder/secret-refs/OPENAI_TUNNEL_API_KEY
```

`tunnel-client` accepts only `env:NAME` or `file:/path` for `--runtime-api-key`
and `--admin-key`, and the host asserts that form before spawning. A literal in
argv would be visible to every local user.

Once the credentials are stored, both commands resolve them on their own — no
exports required:

```bash
chatgpt-local-coder tunnel init      # uses OPENAI_ADMIN_KEY for alias creation
chatgpt-local-coder tunnel connect   # uses OPENAI_TUNNEL_API_KEY and OPENAI_TUNNEL_ID
```

To point `init` at a differently-named variable, pass a reference rather than a
key: `--admin-key env:MY_ADMIN_KEY`. A literal is rejected.

## `ADMIN_TOKEN` and the admin API

`ADMIN_TOKEN` works from either source, but through a narrow path: the guard
reads `process.env.ADMIN_TOKEN`, so the server hydrates the variable from the
secret store at startup, before the admin server binds. An exported value still
wins.

The practical consequence is that changing the stored token has no effect on a
running server. Restart it.

```bash
chatgpt-local-coder secrets set ADMIN_TOKEN     # store it
chatgpt-local-coder up                          # hydrated at startup
```

Then, from another shell — the store deliberately does not put the value in your
environment, so a client has to be given it explicitly:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3001/ui/
```

## Rotating and removing

```bash
chatgpt-local-coder secrets set OPENAI_TUNNEL_API_KEY      # overwrites
chatgpt-local-coder secrets delete OPENAI_TUNNEL_API_KEY
rm -rf ~/.config/chatgpt-local-coder/secret-refs           # regenerated on next connect
```

Rotate on the OpenAI side too — deleting the local copy does not revoke the key.
Restart the tunnel after rotating (`tunnel stop`, then `tunnel connect`); a
running daemon holds the old key.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `OPENAI_TUNNEL_API_KEY is not set` from `tunnel connect` | Neither the environment nor `secrets.json` has it. Run `secrets list`. |
| Stored a new key, still authenticating as the old one | A shell export is shadowing the file, or the daemon is still running with the old key. |
| `doctor` says `set` but the tunnel rejects the key | The key lacks Tunnels Read + Use, or it belongs to a different organization. |
| A brand-new tunnel rejects the connection | It is not active yet. Wait 25–30 seconds after creating it. |
| Authentication fails with a key you are sure is right | A trailing newline came along with the paste. `secrets set` trims; hand-editing does not. |
| The admin API accepts unauthenticated calls after storing a token | The server was already running when you stored it. Restart. |
| `Alias creation failed` during `tunnel init` | No admin key, or one without the admin-key permission. Store `OPENAI_ADMIN_KEY`, pass `--admin-key env:NAME`, or create the tunnel in the Tunnels web page and skip the step. |
| The Tunnels page offers no **Create** button | Your role lacks Tunnels Manage. |
