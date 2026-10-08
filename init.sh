#!/bin/bash
# Set up an agent home and profile for deepbot.
#
# Idempotent: existing files are kept, never overwritten. Persona files are yours
# to edit, so a re-run must not clobber them.
#
#   ./init.sh                                  # ~/dsh-agent + profile "agent"
#   ./init.sh --home ~/dsh-agent-work --profile agent-work
#   ./init.sh --dry-run                        # show what would happen
#   ./init.sh --skip-profile                   # scaffold the home only
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
HOME_DIR="${DEEPBOT_HOME:-$HOME/dsh-agent}"
PROFILE="${DEEPBOT_PROFILE:-agent}"
PORT="${DEEPBOT_PORT:-19500}"
SKIP_PROFILE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="${2:?--home needs a directory}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --skip-profile) SKIP_PROFILE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "   would run: $*"; else "$@"; fi
}

echo "deepbot setup"
echo "  repository : $REPO_DIR"
echo "  agent home : $HOME_DIR"
[ "$SKIP_PROFILE" -eq 0 ] && echo "  profile    : $DSH_HOME_DIR/profiles/$PROFILE (port $PORT)"
[ "$DRY_RUN" -eq 1 ] && echo "  (dry run — nothing is written)"

echo
echo "1) agent home"
run mkdir -p "$HOME_DIR/memory" "$HOME_DIR/state"
# Marks this directory as the instruction-search root. Without it the loader climbs
# to the filesystem boundary and can pick up instruction files that are not yours.
run touch "$HOME_DIR/.deepbot-root"
for file in SOUL.md AGENTS.md USER.md MEMORY.md; do
  if [ -e "$HOME_DIR/$file" ]; then
    echo "   keep    $file (already there)"
  else
    if [ -e "$REPO_DIR/agent/$file" ]; then
      run cp "$REPO_DIR/agent/$file" "$HOME_DIR/$file"
      echo "   create  $file (from agent/$file — edit it, it is your persona)"
    fi
  fi
done

if [ "$SKIP_PROFILE" -eq 0 ]; then
  echo
  echo "2) gateway profile"
  if [ -e "$DSH_HOME_DIR/profiles/$PROFILE" ]; then
    echo "   keep    $DSH_HOME_DIR/profiles/$PROFILE (already there)"
  else
    run mkdir -p "$DSH_HOME_DIR/profiles"
    run cp -r "$REPO_DIR/profile" "$DSH_HOME_DIR/profiles/$PROFILE"
    echo "   create  $DSH_HOME_DIR/profiles/$PROFILE"
  fi
  DSH_BIN="$(command -v dsh || true)"
  if [ -z "$DSH_BIN" ]; then
    echo "   note    the dsh CLI is not on PATH; register this repo yourself:"
    echo "           dsh plugin --profile $PROFILE add $REPO_DIR"
  else
    echo "   register this repository as a bundle for the profile:"
    run "$DSH_BIN" plugin --profile "$PROFILE" add "$REPO_DIR"
  fi
fi

echo
echo "Next"
echo "  1. credentials (never stored in this repository):"
echo "       SLACK_BOT_TOKEN / SLACK_APP_TOKEN in $DSH_HOME_DIR/.env   (chmod 600)"
echo "  2. write your persona and check the budgets:"
echo "       node tools/persona-check.mjs $HOME_DIR"
echo "  3. run it:"
echo "       node test/run-scenario.mjs            # needs a model credential"
echo "       DEEPBOT_HOME=$HOME_DIR DEEPBOT_PORT=$PORT ./service/install-service.sh"
