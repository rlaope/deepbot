#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the watch runner as a launchd job (evaluates due watches every minute).
#
#   ./install-watch.sh                    install
#   ./install-watch.sh --status | --uninstall
#   INTERVAL_S=120 ./install-watch.sh
#
# Watches come from two places, merged by id:
#   ~/.dsh/watches.json            the operator's own file
#   <agent home>/watches/*.json    watches the agent created with its file tools
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
LABEL="ai.deepbot.watch"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL_S="${INTERVAL_S:-60}"
NODE="${DEEPBOT_NODE:-$(command -v node || echo /usr/local/bin/node)}"
RUNTIME_DIR="${DEEPBOT_RUNTIME_DIR:-$HOME/.dsh/service}"
AGENT_HOME="${DEEPBOT_HOME:-$HOME/dsh-agent}"

case "${1:-}" in
--status)
  echo "── watch job: $LABEL"
  launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 \
    && launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|runs|last exit code) " | sed 's/^/   /' \
    || echo "   not registered"
  echo "── watches"
  [ -f "$HOME/.dsh/watches.json" ] && echo "   host:  $HOME/.dsh/watches.json" || echo "   host:  (none)"
  ls "$AGENT_HOME/watches"/*.json 2>/dev/null | sed 's/^/   agent: /' || echo "   agent: (none)"
  exit 0 ;;
--uninstall)
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && echo "   stopped" || echo "   (not running)"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "   removed $PLIST"
  exit 0 ;;
esac

echo "=== installing the deepbot watch runner ==="
[ -x "$NODE" ] || { echo "❌ node not found: $NODE"; exit 1; }
mkdir -p "$RUNTIME_DIR" "$AGENT_HOME/watches" "$HOME/.dsh"
cp "$DIR/watch.mjs" "$RUNTIME_DIR/watch.mjs"; chmod +x "$RUNTIME_DIR/watch.mjs"
echo "✅ runtime copy: $RUNTIME_DIR/watch.mjs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$RUNTIME_DIR/watch.mjs</string></array>
  <key>WorkingDirectory</key><string>$RUNTIME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DEEPBOT_HOME</key><string>$AGENT_HOME</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL_S</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HOME/.dsh/slack-state/watch.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.dsh/slack-state/watch.err.log</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null 2>&1 || { echo "❌ plist failed plutil -lint"; exit 1; }
if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null; sleep 1; fi
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>&1 | sed 's/^/   /'
sleep 1
echo "── dry run"
DEEPBOT_HOME="$AGENT_HOME" "$NODE" "$RUNTIME_DIR/watch.mjs" --dry-run | sed 's/^/   /'
echo
echo "evaluates every ${INTERVAL_S}s.  status: ./install-watch.sh --status"
