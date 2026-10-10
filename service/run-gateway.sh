#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Run the DeepSeek Harness gateway under a supervisor (launchd, systemd, ...).
#
# Why this wrapper exists:
#   1) A gateway may be started from inside another DSH session. That shell
#      carries DSH_PROFILE / DSH_SESSION_ID / DSH_PROFILE_DIR, and inheriting
#      them makes the gateway adopt the wrong profile or session identity. They
#      are stripped here.
#   2) The working directory must be stable: session resume is bound to the
#      recorded cwd, so the agent home is resolved once and fixed here.
#
# Environment:
#   DSH_BIN          path to the `dsh` executable
#   DEEPBOT_PROFILE  profile name to boot            (default: agent)
#   DEEPBOT_HOME     agent home = session cwd        (default: $HOME/.deepbot)
#   DEEPBOT_PORT     local web UI port               (default: 19500)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export DIR

unset DSH_PROFILE DSH_PROFILE_DIR DSH_SESSION_ID DSH_WEB_URL DSH_SHELL

DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
PROFILE="${DEEPBOT_PROFILE:-agent}"
AGENT_HOME="${DEEPBOT_HOME:-$HOME/.deepbot}"
PORT="${DEEPBOT_PORT:-19500}"

# ── Build the TypeScript sources ────────────────────────────────────────────
# The profile loads dist/index.js (package.json "main"), so the compiled entry has
# to exist and be current. A build failure must never take a working bot down: if
# dist already exists, start with it and shout; only refuse when there is nothing
# to load.
REPO="${DEEPBOT_REPO:-}"
if [ -n "$REPO" ] && [ -f "$REPO/tsconfig.json" ]; then
  NODE_BIN="${DEEPBOT_NODE:-}"
  if [ -z "$NODE_BIN" ]; then
    for candidate in "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" "$(command -v node 2>/dev/null)"; do
      [ -n "$candidate" ] && [ -x "$candidate" ] && { NODE_BIN="$candidate"; break; }
    done
  fi
  TSC="$REPO/node_modules/typescript/lib/tsc.js"
  ENTRY="$REPO/dist/index.js"
  STALE=0
  [ -f "$ENTRY" ] || STALE=1
  if [ "$STALE" -eq 0 ] && [ -n "$(find "$REPO" -name '*.ts' -newer "$ENTRY" -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]; then
    STALE=1
  fi
  if [ "$STALE" -eq 1 ]; then
    if [ -z "$NODE_BIN" ] || [ ! -f "$TSC" ]; then
      echo "[gateway] dist is missing or stale and the toolchain is unavailable (node=$NODE_BIN tsc=$TSC)" >&2
      [ -f "$ENTRY" ] || { echo "[gateway] nothing to load; refusing to start. Run: pnpm install && pnpm run build" >&2; exit 1; }
    else
      echo "[gateway] building TypeScript (dist missing or older than the sources)"
      if "$NODE_BIN" "$TSC" -p "$REPO/tsconfig.json" > "$AGENT_HOME/state/build.log" 2>&1; then
        echo "[gateway] build ok"
      else
        echo "[gateway] BUILD FAILED — see $AGENT_HOME/state/build.log" >&2
        tail -5 "$AGENT_HOME/state/build.log" >&2 || true
        [ -f "$ENTRY" ] || { echo "[gateway] no dist to fall back to; refusing to start" >&2; exit 1; }
        echo "[gateway] starting with the existing dist anyway" >&2
      fi
    fi
  fi
fi

if [ ! -x "$DSH_BIN" ]; then
  echo "[gateway] dsh not found at: $DSH_BIN" >&2
  echo "[gateway] set DSH_BIN to your installation." >&2
  exit 2
fi

mkdir -p "$AGENT_HOME"
cd "$AGENT_HOME" || { echo "[gateway] cannot enter agent home: $AGENT_HOME" >&2; exit 2; }

echo "[gateway] starting $(date '+%Y-%m-%d %H:%M:%S') — profile=$PROFILE port=$PORT cwd=$AGENT_HOME"

# Read isolation.
#
# The harness sandbox governs WRITES. Its macOS Seatbelt profile is allow-default
# with (deny file-write*), and the Windows ACL backend documents reads as
# unconfined — so an agent can read anything the user can, including another
# bot's token file. Measured: unwrapped, the agent read a canary inside a
# different agent's directory and answered with its contents.
#
# This wraps the whole gateway in an OS profile, so every child it spawns
# inherits the denial. The profile denies reads of other instances' homes and of
# retired bots' data, and is generated per instance by install-service.sh.
PROFILE_FILE="${DEEPBOT_READ_PROFILE:-$DIR/read-isolation.sb}"
if [ -f "$PROFILE_FILE" ] && [ -x /usr/bin/sandbox-exec ]; then
  echo "[gateway] read isolation: $(grep -c 'deny file-read' "$PROFILE_FILE") denial(s) from $PROFILE_FILE"
  exec /usr/bin/sandbox-exec -f "$PROFILE_FILE" "$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open
fi
if [ -f "$PROFILE_FILE" ]; then
  echo "[gateway] WARNING: $PROFILE_FILE exists but sandbox-exec is unavailable — reads are NOT confined" >&2
fi
exec "$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open
