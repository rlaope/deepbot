#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the gateway as a macOS launchd service (auto-start at login).
#
#   ./install-service.sh              install + start + verify
#   ./install-service.sh --status     show state and recent plugin log
#   ./install-service.sh --uninstall  stop and remove
#
# ── The one thing that will bite you: macOS TCC ──────────────────────────────
# launchd does NOT inherit your shell's privacy permissions. If the wrapper
# script lives under ~/Desktop, ~/Documents or ~/Downloads, the job fails with:
#
#   shell-init: error retrieving current directory: getcwd: cannot access
#   parent directories: Operation not permitted
#
# So this installer COPIES the wrapper to a runtime directory under $HOME
# (default ~/.deepbot/service) and points the plist there. Keep the repository
# wherever you like; the runtime copy is what launchd executes.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

LABEL="ai.deepbot-harness.gateway"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

AGENT_HOME="${DEEPBOT_HOME:-$HOME/.deepbot}"
RUNTIME_DIR="${DEEPBOT_RUNTIME_DIR:-$AGENT_HOME/service}"
PORT="${DEEPBOT_PORT:-19500}"
PROFILE="${DEEPBOT_PROFILE:-agent}"
DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"

case "${1:-}" in
--status)
  echo "── service: $LABEL"
  if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
    launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|pid|last exit code) " | sed 's/^/   /'
  else
    echo "   not registered"
  fi
  curl -s -o /dev/null -w "   http://127.0.0.1:$PORT -> HTTP %{http_code} (401 = up, auth required)\n" --max-time 4 "http://127.0.0.1:$PORT" || echo "   port $PORT closed"
  echo "── plugin log"
  tail -8 "$HOME/.dsh/slack-state/platform-slack.log" 2>/dev/null | sed 's/^/   /' || echo "   (no log yet)"
  exit 0
  ;;
--uninstall)
  echo "── uninstalling $LABEL"
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && echo "   service stopped" || echo "   (already stopped)"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "   removed $PLIST"
  echo "   runtime copy kept at $RUNTIME_DIR (delete it yourself if you want)"
  exit 0
  ;;
esac

echo "=== installing deepbot-harness gateway service ==="
[ -x "$DSH_BIN" ] || { echo "❌ dsh not found: $DSH_BIN (set DSH_BIN)"; exit 1; }

# 1) runtime copy, outside TCC-protected folders
mkdir -p "$RUNTIME_DIR" "$AGENT_HOME" "$AGENT_HOME/state"
cp "$DIR/run-gateway.sh" "$RUNTIME_DIR/run-gateway.sh"
chmod +x "$RUNTIME_DIR/run-gateway.sh"
echo "✅ runtime copy: $RUNTIME_DIR/run-gateway.sh"

# 2) plist
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$RUNTIME_DIR/run-gateway.sh</string></array>
  <key>WorkingDirectory</key><string>$RUNTIME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DEEPBOT_PROFILE</key><string>$PROFILE</string>
    <key>DEEPBOT_HOME</key><string>$AGENT_HOME</string>
    <key>DEEPBOT_PORT</key><string>$PORT</string>
    <key>DSH_BIN</key><string>$DSH_BIN</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$AGENT_HOME/state/gateway.out.log</string>
  <key>StandardErrorPath</key><string>$AGENT_HOME/state/gateway.err.log</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null 2>&1 || { echo "❌ plist failed plutil -lint"; plutil -lint "$PLIST"; exit 1; }
echo "✅ plist: $PLIST"

# 3) (re)start
if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
  echo "   already registered — restarting"
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null; sleep 1
fi
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>&1 | sed 's/^/   /'
sleep 10

echo
echo "── verify"
launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 && launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|pid) " | sed 's/^/   /' || { echo "   ❌ not registered"; exit 1; }
curl -s -o /dev/null -w "   http://127.0.0.1:$PORT -> HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:$PORT" || true

if tail -30 "$HOME/.dsh/slack-state/platform-slack.log" 2>/dev/null | grep -q "Socket Mode connected"; then
  echo "   ✅ Slack connected"
else
  echo "   ⚠️  no 'Socket Mode connected' yet — check:"
  tail -12 "$AGENT_HOME/state/gateway.err.log" 2>/dev/null | sed 's/^/   /'
fi

cat <<EOF

════════════════════════════════════════════════════════════
 installed. the gateway now starts at login and restarts on exit.

   status:   ./install-service.sh --status
   logs:     tail -f $HOME/.dsh/slack-state/platform-slack.log
   out/err:  $AGENT_HOME/state/gateway.{out,err}.log
   stop:     launchctl bootout gui/$UID_N/$LABEL
   remove:   ./install-service.sh --uninstall

 The web UI is at http://127.0.0.1:$PORT — its auth token is printed
 on the first line of gateway.out.log.
════════════════════════════════════════════════════════════
EOF
