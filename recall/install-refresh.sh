#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Keep the recall index fresh.
#
#   ./install-refresh.sh              install (rebuild every REFRESH_MIN minutes)
#   ./install-refresh.sh --status
#   ./install-refresh.sh --uninstall
#   REFRESH_MIN=5 ./install-refresh.sh
#
# Why a separate job: the indexer must read the session store, which lives
# outside the agent's home. The agent runs confined to its home, so it can only
# read the index this job writes. Host builds, agent reads.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

LABEL="ai.deepbot.recall-index"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

AGENT_HOME="${DEEPBOT_HOME:-$HOME/dsh-agent}"
REFRESH_MIN="${REFRESH_MIN:-10}"
NODE="${DEEPBOT_NODE:-$(command -v node || echo /usr/local/bin/node)}"
SCRIPT_DIR="$(pwd)"
INDEX="$AGENT_HOME/memory/recall-index.jsonl"

case "${1:-}" in
--status)
  echo "── refresh job: $LABEL"
  if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
    launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|pid|last exit code) " | sed 's/^/   /'
  else
    echo "   not registered"
  fi
  echo "── index"
  if [ -f "$INDEX" ]; then
    echo "   $INDEX"
    echo "   $(wc -l < "$INDEX" | tr -d ' ') messages, modified $(stat -f '%Sm' "$INDEX")"
  else
    echo "   missing: $INDEX"
  fi
  exit 0
  ;;
--uninstall)
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && echo "   service stopped" || echo "   (not running)"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "   removed $PLIST"
  exit 0
  ;;
esac

echo "=== installing recall refresh ($LABEL) ==="
[ -x "$NODE" ] || { echo "❌ node not found: $NODE (set DEEPBOT_NODE)"; exit 1; }
[ -f "$SCRIPT_DIR/deepbot-recall.mjs" ] || { echo "❌ deepbot-recall.mjs not found next to this script"; exit 1; }
mkdir -p "$AGENT_HOME/memory"

# Rebuild once now so the agent has something to read immediately.
echo "── building the index once"
DEEPBOT_HOME="$AGENT_HOME" "$NODE" "$SCRIPT_DIR/deepbot-recall.mjs" index | sed 's/^/   /'

# launchd has no cron-style interval for agents, so the job runs the indexer and
# re-schedules itself by exiting; StartInterval keeps it periodic.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SCRIPT_DIR/deepbot-recall.mjs</string>
    <string>index</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEEPBOT_HOME</key><string>$AGENT_HOME</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>$((REFRESH_MIN * 60))</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$AGENT_HOME/state/recall-index.out.log</string>
  <key>StandardErrorPath</key><string>$AGENT_HOME/state/recall-index.err.log</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null 2>&1 || { echo "❌ plist failed plutil -lint"; plutil -lint "$PLIST"; exit 1; }
echo "✅ plist: $PLIST"
mkdir -p "$AGENT_HOME/state"

if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null; sleep 1
fi
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>&1 | sed 's/^/   /'
echo
echo "rebuilds every ${REFRESH_MIN} minute(s)."
echo "  status:  ./install-refresh.sh --status"
echo "  force:   DEEPBOT_HOME=$AGENT_HOME $NODE $SCRIPT_DIR/deepbot-recall.mjs index"
echo "  remove:  ./install-refresh.sh --uninstall"
