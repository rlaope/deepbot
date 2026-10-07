#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the health probe as a launchd job.
#
#   ./install-health.sh                                   (every 5 minutes)
#   DEEPBOT_ALERT_TO=U123 ./install-health.sh             (Slack DM on failure)
#   INTERVAL_S=120 ./install-health.sh
#   ./install-health.sh --status | --uninstall
#
# The probe restarts the service and only alerts if that fails, so a blip that
# heals itself stays quiet. Alerts are rate-limited.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

LABEL="ai.deepbot.health"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL_S="${INTERVAL_S:-300}"
NODE="${DEEPBOT_NODE:-$(command -v node || echo /usr/local/bin/node)}"
RUNTIME_DIR="${DEEPBOT_RUNTIME_DIR:-$HOME/.dsh/service}"

case "${1:-}" in
--status)
  echo "── health job: $LABEL"
  if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
    launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|runs|last exit code) " | sed 's/^/   /'
  else
    echo "   not registered"
  fi
  echo "── current state"
  [ -x "$NODE" ] && "$NODE" "$RUNTIME_DIR/health-check.mjs" --status 2>/dev/null | sed 's/^/   /' || echo "   (probe not installed)"
  exit 0
  ;;
--uninstall)
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && echo "   stopped" || echo "   (not running)"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "   removed $PLIST"
  exit 0
  ;;
esac

echo "=== installing the deepbot health probe ==="
[ -x "$NODE" ] || { echo "❌ node not found: $NODE (set DEEPBOT_NODE)"; exit 1; }
[ -f "$DIR/health-check.mjs" ] || { echo "❌ health-check.mjs not found next to this script"; exit 1; }

# Runtime copy outside TCC-protected folders, like the gateway itself.
mkdir -p "$RUNTIME_DIR" "$HOME/.dsh/slack-state"
cp "$DIR/health-check.mjs" "$RUNTIME_DIR/health-check.mjs"
chmod +x "$RUNTIME_DIR/health-check.mjs"
echo "✅ runtime copy: $RUNTIME_DIR/health-check.mjs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$RUNTIME_DIR/health-check.mjs</string></array>
  <key>WorkingDirectory</key><string>$RUNTIME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DEEPBOT_ALERT_TO</key><string>${DEEPBOT_ALERT_TO:-}</string>
    <key>DEEPBOT_SERVICE_LABEL</key><string>${DEEPBOT_SERVICE_LABEL:-ai.deepbot.gateway}</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL_S</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HOME/.dsh/slack-state/health-probe.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.dsh/slack-state/health-probe.err.log</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null 2>&1 || { echo "❌ plist failed plutil -lint"; plutil -lint "$PLIST"; exit 1; }
echo "✅ plist: $PLIST"
if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null; sleep 1; fi
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>&1 | sed 's/^/   /'
sleep 2
echo
echo "── first probe"
"$NODE" "$RUNTIME_DIR/health-check.mjs" --status | sed 's/^/   /'
cat <<EOF

════════════════════════════════════════════════════════════
 health probe installed — runs every ${INTERVAL_S}s.

   status:  ./install-health.sh --status
   logs:    $HOME/.dsh/slack-state/health-probe.out.log
   alerts:  ${DEEPBOT_ALERT_TO:-<unset — failures are logged, not sent>}
   remove:  ./install-health.sh --uninstall
════════════════════════════════════════════════════════════
EOF
