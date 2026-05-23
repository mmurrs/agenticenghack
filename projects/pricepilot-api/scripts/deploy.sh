#!/usr/bin/env bash
# PricePilot Search - deploy to EigenCompute from the local Dockerfile.
#
# Usage:
#   ./scripts/deploy.sh              # upgrade existing app (reads .deploy-config)
#   ./scripts/deploy.sh --fresh      # first-time deploy (creates app, saves config)
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.mainnet"
CONFIG=".deploy-config"
ENVIRONMENT="${ENVIRONMENT:-mainnet-alpha}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g1-micro-1v}"

# Derive app name from SERVICE_NAME in the env file (fallback to repo dir)
APP_NAME="${APP_NAME:-}"
if [[ -z "$APP_NAME" && -f "$ENV_FILE" ]]; then
  APP_NAME="$(grep -E '^SERVICE_NAME=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
fi
APP_NAME="${APP_NAME:-$(basename "$(pwd)")}"

[[ -f "$ENV_FILE" ]] || { echo "FATAL: $ENV_FILE missing. Run ./scripts/init.sh first." >&2; exit 1; }
command -v ecloud >/dev/null 2>&1 || { echo "FATAL: ecloud CLI not found. Install: npm install -g @layr-labs/ecloud-cli@dev" >&2; exit 1; }
REPO_URL="$(git config --get remote.origin.url 2>/dev/null || echo)"
REPO_URL="${REPO_URL%.git}"
REPO_URL="${REPO_URL/git@github.com:/https://github.com/}"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo local)"

# ---- Pick deploy mode ----------------------------------------------------
MODE="upgrade"
for arg in "$@"; do
  case "$arg" in
    --fresh) MODE="fresh" ;;
  esac
done

if [[ "$MODE" == "upgrade" ]]; then
  if [[ ! -f "scripts/$CONFIG" ]]; then
    echo "No scripts/$CONFIG found — this looks like a first deploy."
    echo "Re-run with --fresh to create a new app:"
    echo "  ./scripts/deploy.sh --fresh"
    exit 1
  fi
  # shellcheck disable=SC1090
  source "scripts/$CONFIG"
  [[ -n "${APP_ID:-}" ]] || { echo "FATAL: APP_ID missing in scripts/$CONFIG" >&2; exit 1; }

  echo "Upgrading $APP_ID on $ENVIRONMENT from local Dockerfile..."
  ECLOUD_ENV="$ENVIRONMENT" ecloud compute app upgrade "$APP_ID" \
    --environment "$ENVIRONMENT" \
    --dockerfile Dockerfile \
    --env-file "$ENV_FILE" \
    --env GIT_SHA="$COMMIT" \
    --env BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --env REPO_URL="$REPO_URL" \
    --env APP_ID="$APP_ID" \
    --env ENVIRONMENT="$ENVIRONMENT" \
    --instance-type "$INSTANCE_TYPE" \
    --log-visibility public \
    --resource-usage-monitoring enable \
    --force || {
      status=$?
      [[ $status -eq 141 ]] || exit $status  # harmless SIGPIPE from yes-pipe
    }
else
  echo "Creating new app '$APP_NAME' on $ENVIRONMENT from local Dockerfile..."
  ecloud compute app deploy \
    --name "$APP_NAME" \
    --environment "$ENVIRONMENT" \
    --dockerfile Dockerfile \
    --env-file "$ENV_FILE" \
    --env GIT_SHA="$COMMIT" \
    --env BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --env REPO_URL="$REPO_URL" \
    --env ENVIRONMENT="$ENVIRONMENT" \
    --instance-type "$INSTANCE_TYPE" \
    --log-visibility public \
    --resource-usage-monitoring enable \
    --force 2>&1 | tee /tmp/dual402-deploy.log

  APP_ID="$(grep -oE '0x[a-fA-F0-9]{40}' /tmp/dual402-deploy.log | head -1 || true)"
  if [[ -z "$APP_ID" ]]; then
    echo "WARN: couldn't extract APP_ID from deploy output. Check manually:" >&2
    echo "  ecloud compute app list --environment $ENVIRONMENT" >&2
  else
    cat > "scripts/$CONFIG" <<EOF
APP_ID=$APP_ID
ENVIRONMENT=$ENVIRONMENT
REPO_URL=$REPO_URL
EOF
    echo "Saved scripts/$CONFIG — future deploys will upgrade this app."
    echo "APP_ID: $APP_ID"
    echo "Verify: https://verify.eigencloud.xyz/app/$APP_ID"
  fi
fi

echo ""
echo "Watch boot logs:"
echo "  ecloud compute app logs ${APP_ID:-<APP_ID>} --environment $ENVIRONMENT --watch"
