#!/usr/bin/env bash
# Sync latest code and skills to Hermes WITHOUT touching ~/.hermes/.env
# Run this from inside the Daytona workspace after a git pull, or let it pull for you.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRICEPILOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PRICEPILOT_DIR/../.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

echo "==> Pulling latest code..."
cd "$REPO_ROOT" && git pull

echo "==> Installing Python deps..."
pip install -q -r "$PRICEPILOT_DIR/requirements.txt"

echo "==> Syncing skills to Hermes..."
mkdir -p "$HERMES_HOME/skills/pricepilot"
cp -r "$PRICEPILOT_DIR/skills/"* "$HERMES_HOME/skills/pricepilot/"
echo "  Skills updated: $(ls "$HERMES_HOME/skills/pricepilot/")"

echo "==> Updating Hermes config base_url from .env..."
if [ -f "$HERMES_HOME/.env" ]; then
  set -a && source "$HERMES_HOME/.env" && set +a || true
fi
if [ -n "${OPENAI_BASE_URL:-}" ]; then
  cp "$PRICEPILOT_DIR/hermes/hermes-config.yaml" "$HERMES_HOME/config.yaml"
  sed -i "s|OPENAI_BASE_URL_PLACEHOLDER|$OPENAI_BASE_URL|" "$HERMES_HOME/config.yaml"
  echo "  Config updated with base_url=$OPENAI_BASE_URL"
fi

echo "==> Restarting Hermes gateway..."
pkill -f "hermes gateway" 2>/dev/null && sleep 3 || true
setsid bash "$PRICEPILOT_DIR/hermes/start.sh" > /dev/null 2>&1 &

echo ""
echo "Deploy complete. Gateway restarting in background."
echo "Check logs: tail -f $HERMES_HOME/gateway.log"
