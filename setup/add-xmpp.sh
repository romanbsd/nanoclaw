#!/usr/bin/env bash
# Install/build XMPP gateway packages and ensure bridge adapter is registered.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

log() { echo "[add-xmpp] $*" >&2; }

emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: ADD_XMPP ==="
  echo "STATUS: ${status}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

required_vars=(XMPP_COMPONENT_JID XMPP_COMPONENT_SECRET XMPP_DEFAULT_AGENT_JID)
for v in "${required_vars[@]}"; do
  if [ -z "${!v:-}" ]; then
    emit_status failed "${v} not set"
    exit 1
  fi
done

log "Installing workspace dependencies…"
pnpm install >&2

log "Building agent-xmpp packages…"
pnpm --filter @agent-xmpp/protocol build >&2
pnpm --filter @agent-xmpp/gateway build >&2
pnpm --filter @agent-xmpp/mcp build >&2

if ! grep -q "^import './xmpp-bridge.js';" src/channels/index.ts 2>/dev/null; then
  echo "import './xmpp-bridge.js';" >> src/channels/index.ts
fi

log "Building host…"
pnpm run build >&2

# Persist env keys to .env
touch .env
for key in XMPP_COMPONENT_JID XMPP_AGENT_DOMAIN XMPP_COMPONENT_SERVICE XMPP_COMPONENT_SECRET \
  XMPP_DEFAULT_AGENT_JID XMPP_GATEWAY_URL XMPP_BRIDGE_WEBHOOK_SECRET XMPP_BRIDGE_WEBHOOK_URL XMPP_BRIDGE_WEBHOOK_PORT; do
  val="${!key:-}"
  [ -z "$val" ] && continue
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$val" -F= '$1==k{print k"="v; next}{print}' .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${val}" >> .env
  fi
done

mkdir -p data/env
cp .env data/env/env

emit_status success
