#!/usr/bin/env bash
#
# Interactive credential entry for chatgpt-local-coder.
#
# Values are typed, never passed as arguments: a command line is world-readable
# through /proc on Linux and through `ps` everywhere, so a key given as an
# argument leaks to every local user. Nothing here echoes a value back, writes
# one to a log, or leaves one in shell history.
#
# The store is <config dir>/secrets.json, created 0600 before any content
# reaches it. This mirrors writeStore() in src/lib/secrets.ts; the two must
# agree on location, format and mode.

set -euo pipefail

APP_NAME="chatgpt-local-coder"

# Mirrors configDir() in src/config/paths.ts. Kept in sync by hand — if that
# function changes, this changes with it.
config_dir() {
  if [ -n "${CLC_CONFIG_DIR:-}" ]; then
    printf '%s\n' "$(cd "$(dirname "$CLC_CONFIG_DIR")" 2>/dev/null && pwd)/$(basename "$CLC_CONFIG_DIR")"
    return
  fi

  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "$HOME/Library/Application Support/$APP_NAME"
      ;;
    MINGW* | MSYS* | CYGWIN*)
      printf '%s\n' "${APPDATA:-$HOME/AppData/Roaming}/$APP_NAME"
      ;;
    *)
      printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/$APP_NAME"
      ;;
  esac
}

CONFIG_DIR="$(config_dir)"
SECRETS_FILE="$CONFIG_DIR/secrets.json"

require_node() {
  command -v node >/dev/null 2>&1 || {
    echo "error: node is required (this host is a Node CLI, so it should already be installed)" >&2
    exit 1
  }
}

# Read/modify/write the store in one node call. The value travels in the
# environment, never in argv.
store_write() {
  CLC_TARGET="$SECRETS_FILE" CLC_NAME="$1" CLC_VALUE="${2-}" CLC_ACTION="${3:-set}" node -e '
    const fs = require("fs");
    const path = require("path");
    const target = process.env.CLC_TARGET;

    let store = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) store = parsed;
    } catch { /* absent or unreadable: start clean, the caller already warned */ }

    if (process.env.CLC_ACTION === "delete") delete store[process.env.CLC_NAME];
    else store[process.env.CLC_NAME] = process.env.CLC_VALUE;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(store, null, 2) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    // openSync only applies the mode when it creates the file; an existing
    // file keeps whatever mode it had.
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  '
}

# Names only. A value is never read out of the store by this script.
store_has() {
  CLC_TARGET="$SECRETS_FILE" CLC_NAME="$1" node -e '
    const fs = require("fs");
    try {
      const store = JSON.parse(fs.readFileSync(process.env.CLC_TARGET, "utf-8"));
      process.exit(store && store[process.env.CLC_NAME] ? 0 : 1);
    } catch { process.exit(1); }
  '
}

restrict_windows_acl() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      command -v icacls >/dev/null 2>&1 || return 0
      MSYS_NO_PATHCONV=1 icacls "$SECRETS_FILE" /inheritance:r /grant:r "${USERNAME:-$USER}:F" >/dev/null 2>&1 || true
      ;;
  esac
}

status_line() {
  local name="$1" state source
  if [ -n "${!name:-}" ]; then
    state="set"; source="environment — overrides the file"
  elif store_has "$name"; then
    state="set"; source="secrets.json"
  else
    state="unset"; source="-"
  fi
  printf '  %-24s %-6s %s\n' "$name" "$state" "$source"
}

show_status() {
  echo
  echo "Stored in $SECRETS_FILE"
  if [ -e "$SECRETS_FILE" ]; then
    printf '  mode: %s\n' "$(ls -l "$SECRETS_FILE" | awk '{print $1}')"
  fi
  echo
  for name in OPENAI_TUNNEL_API_KEY OPENAI_TUNNEL_ID OPENAI_ADMIN_KEY ADMIN_TOKEN; do
    status_line "$name"
  done
  echo
  echo "Names and state only — no value is ever printed."
}

# $1 name, $2 human description, $3 "hidden"|"visible"
prompt_for() {
  local name="$1" description="$2" mode="$3" value=""

  echo
  echo "$name — $description"

  if [ -n "${!name:-}" ]; then
    echo "  note: \$$name is exported in this shell and takes precedence over the file."
  fi

  if store_has "$name"; then
    printf '  already set. Replace it? [y/N] '
    local reply=""
    read -r reply || true
    case "$reply" in
      [yY] | [yY][eE][sS]) ;;
      *) echo "  kept."; return 0 ;;
    esac
  fi

  if [ "$mode" = "hidden" ]; then
    printf '  paste the value (input is hidden, Enter to skip): '
    read -r -s value || true
    echo
  else
    printf '  value (Enter to skip): '
    read -r value || true
  fi

  # A pasted key often carries a trailing newline or a stray space, which would
  # otherwise be stored and then fail authentication in a way that looks random.
  value="$(printf '%s' "$value" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  if [ -z "$value" ]; then
    echo "  skipped."
    return 0
  fi

  store_write "$name" "$value"
  restrict_windows_acl
  # Length only. Enough to catch a truncated or empty paste without putting any
  # part of the value on screen.
  echo "  saved (${#value} characters)."
  value=""
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [--show] [--delete NAME] [--help]

Prompts for the credentials chatgpt-local-coder needs and writes them to
  $SECRETS_FILE
with mode 0600. Existing entries are preserved; only what you type is replaced.

  --show          report which names are set, and from where. Prints no values.
  --delete NAME   remove one entry from the store.

Once the CLI is installed, \`chatgpt-local-coder secrets set|list|delete|path\`
does the same thing. This script exists for the machine where you have the
checkout but not the CLI on PATH.

Credentials, and what each is for:

  OPENAI_TUNNEL_API_KEY   the tunnel daemon's runtime key.
                          platform.openai.com/settings/organization/api-keys
                          (the key needs Tunnels Read + Use)

  OPENAI_TUNNEL_ID        which tunnel to attach to.
                          platform.openai.com/settings/organization/tunnels

  OPENAI_ADMIN_KEY        control-plane writes only — creating the tunnel alias
                          during \`tunnel init\`. Never given to the daemon.
                          platform.openai.com/settings/organization/admin-keys

  ADMIN_TOKEN             guards this host's admin API. You choose the value.

Every name is read from the environment first and from the store second, so an
export in your shell silently wins over what you set here. See
docs/credentials.md for how to obtain each value.
EOF
}

main() {
  require_node

  case "${1:-}" in
    -h | --help)
      usage
      exit 0
      ;;
    --show)
      show_status
      exit 0
      ;;
    --delete)
      local name="${2:-}"
      [ -n "$name" ] || { echo "error: --delete needs a name" >&2; exit 2; }
      store_write "$name" "" delete
      restrict_windows_acl
      echo "Removed $name from $SECRETS_FILE."
      exit 0
      ;;
    "") ;;
    *)
      echo "error: unknown option ${1}" >&2
      usage >&2
      exit 2
      ;;
  esac

  echo "chatgpt-local-coder — credential entry"
  echo "Writing to $SECRETS_FILE (mode 0600)."
  echo "Press Enter at any prompt to leave that credential unchanged."

  if [ -e "$SECRETS_FILE" ] && ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"))' "$SECRETS_FILE" 2>/dev/null; then
    echo
    echo "warning: $SECRETS_FILE is not valid JSON and will be replaced." >&2
    printf 'Continue? [y/N] '
    local reply=""
    read -r reply || true
    case "$reply" in
      [yY] | [yY][eE][sS]) ;;
      *) echo "Aborted."; exit 1 ;;
    esac
  fi

  prompt_for OPENAI_TUNNEL_API_KEY "runtime key for the tunnel daemon" hidden
  prompt_for OPENAI_TUNNEL_ID "id of the tunnel to attach to" visible
  prompt_for OPENAI_ADMIN_KEY "admin key for creating the tunnel alias — setup only" hidden
  prompt_for ADMIN_TOKEN "bearer token for the admin API on the admin port" hidden

  if store_has ADMIN_TOKEN; then
    cat <<'EOF'

note: the server hydrates ADMIN_TOKEN from the store at startup, so a running
  server keeps the token it started with. Restart it after changing this one.
EOF
  fi

  show_status
  echo
  echo "Next: chatgpt-local-coder doctor"
}

main "$@"
