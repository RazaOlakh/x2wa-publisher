#!/usr/bin/env bash
# Install / inspect / restart / remove the per-user service that keeps the
# X → WhatsApp controller running on Linux.
#
#   ./scripts/install-startup.sh install    # start it at login
#   ./scripts/install-startup.sh status     # is it up?
#   ./scripts/install-startup.sh restart
#   ./scripts/install-startup.sh uninstall  # stop and remove
#
# No sudo is needed: this is a systemd *user* unit.
set -euo pipefail

SERVICE_NAME="x2wa-controller"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTROLLER_DIR="$PROJECT_DIR/controller"
CONTROLLER_SRC="$CONTROLLER_DIR/src/server.js"
TEMPLATE="$SCRIPT_DIR/${SERVICE_NAME}.service.template"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is for Linux. On Windows use scripts\\windows\\install-startup.ps1" >&2
  exit 1
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/${SERVICE_NAME}.service"

die() { echo "error: $*" >&2; exit 1; }

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for c in /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  die "Node.js 18+ not found in PATH. Install Node.js (https://nodejs.org) and re-run."
}

find_chrome() {
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  echo "/usr/bin/google-chrome-stable"
}

data_root() {
  echo "${XDG_DATA_HOME:-$HOME/.local/share}/x-whatsapp-poster"
}

check_prereqs() {
  [[ -f "$CONTROLLER_SRC" ]] || die "controller not found at $CONTROLLER_SRC"
  [[ -d "$CONTROLLER_DIR/node_modules/whatsapp-web.js" ]] || die "controller dependencies missing - run: (cd '$CONTROLLER_DIR' && npm install)"
}

write_unit() {
  local node session tmp chrome
  node="$(find_node)"
  session="${SESSION_DIR:-$(data_root)/whatsapp-session}"
  tmp="${TMP_ROOT:-$(data_root)/tmp}"
  chrome="$(find_chrome)"
  mkdir -p "$UNIT_DIR"
  sed -e "s|__NODE__|$node|g" \
      -e "s|__CONTROLLER_SRC__|$CONTROLLER_SRC|g" \
      -e "s|__CONTROLLER_DIR__|$CONTROLLER_DIR|g" \
      -e "s|__SESSION_DIR__|$session|g" \
      -e "s|__TMP_ROOT__|$tmp|g" \
      -e "s|__CHROME__|$chrome|g" \
      "$TEMPLATE" > "$UNIT_PATH"
  echo "wrote $UNIT_PATH"
}

do_install() {
  check_prereqs
  command -v systemctl >/dev/null 2>&1 || die "systemd not available on this system"
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg/ffprobe not found - install ffmpeg (e.g. sudo apt install ffmpeg)"
  write_unit
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME.service" >/dev/null
  systemctl --user restart "$SERVICE_NAME.service"
  echo "Installed. Waiting for the controller to report ready..."
  for _ in $(seq 1 30); do
    if curl -sf -m 2 http://127.0.0.1:47825/health 2>/dev/null | grep -q '"state"'; then
      echo "Controller is up: $(curl -s -m 2 http://127.0.0.1:47825/health)"
      echo "It now starts automatically at every login."
      exit 0
    fi
    sleep 2
  done
  echo "Controller did not report ready yet. Check: systemctl --user status $SERVICE_NAME" >&2
  systemctl --user status "$SERVICE_NAME" --no-pager || true
  exit 1
}

do_uninstall() {
  systemctl --user disable --now "$SERVICE_NAME.service" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed $UNIT_PATH. Your WhatsApp session in ${SESSION_DIR:-$(data_root)/whatsapp-session} was left untouched."
}

case "${1:-install}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  status)    systemctl --user status "$SERVICE_NAME" --no-pager; echo; curl -s -m 3 http://127.0.0.1:47825/status || true; echo ;;
  restart)   systemctl --user restart "$SERVICE_NAME"; sleep 2; systemctl --user status "$SERVICE_NAME" --no-pager --lines=5 ;;
  logs)      journalctl --user -u "$SERVICE_NAME" -f ;;
  *) echo "usage: $0 {install|status|restart|logs|uninstall}" >&2; exit 2 ;;
esac