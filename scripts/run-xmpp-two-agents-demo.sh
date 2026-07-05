#!/usr/bin/env bash
# Provision two personality-driven XMPP agents backed by a local Rapid-MLX server.
#
# Start Rapid-MLX yourself first, e.g.:
#   rapid-mlx serve gpt-oss-20b-4bit
#
# Then run:
#   bash scripts/run-xmpp-two-agents-demo.sh
#
# Optional env:
#   RAPID_MLX_URL=http://127.0.0.1:8000
#   RAPID_MLX_MODEL=gpt-oss-20b-4bit
#   DEMO_MUC_ROOM=agents-lounge@conference.example.org
#   DEMO_HUMAN_JID=john@example.org
#   DEMO_HUMAN_PASSWORD=secret
#   KEEP_DEMO=1                      # leave stack up after Ctrl+C
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RAPID_MLX_URL="${RAPID_MLX_URL:-http://127.0.0.1:8000}"
RAPID_MLX_MODEL="${RAPID_MLX_MODEL:-gpt-oss-20b-4bit}"
export RAPID_MLX_URL RAPID_MLX_MODEL

# Match src/install-slug.ts: sha1(projectRoot)[:8] → nanoclaw-agent-v2-<slug>:latest
install_slug() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 1 | awk '{print $1}' | cut -c1-8
  else
    printf '%s' "$1" | sha1sum | awk '{print $1}' | cut -c1-8
  fi
}
CONTAINER_IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent-v2-$(install_slug "$ROOT"):latest}"
export CONTAINER_IMAGE

# Node 22 — better-sqlite3 in this repo is built for ABI 127 (Node 22), not Node 26+.
resolve_node22() {
  if [[ -n "${NANOCLAW_NODE:-}" && -x "${NANOCLAW_NODE}" ]]; then
    local major
    major=$("${NANOCLAW_NODE}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [[ "$major" == "22" ]]; then
      echo "${NANOCLAW_NODE}"
      return
    fi
  fi

  local candidates=()
  candidates+=("/opt/homebrew/opt/node@22/bin/node")
  candidates+=("/usr/local/opt/node@22/bin/node")

  if [[ -n "${NVM_DIR:-}" && -d "${NVM_DIR}/versions/node" ]]; then
    local nvm_node
    nvm_node=$(ls -d "${NVM_DIR}/versions/node"/v22.* 2>/dev/null | sort -V | tail -1)/bin/node
    [[ -x "$nvm_node" ]] && candidates=("$nvm_node" "${candidates[@]}")
  elif [[ -d "${HOME}/.nvm/versions/node" ]]; then
    local nvm_node
    nvm_node=$(ls -d "${HOME}/.nvm/versions/node"/v22.* 2>/dev/null | sort -V | tail -1)/bin/node
    [[ -x "$nvm_node" ]] && candidates=("$nvm_node" "${candidates[@]}")
  fi

  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi

  local bin major
  for bin in "${candidates[@]}"; do
    [[ -z "$bin" || ! -x "$bin" ]] && continue
    major=$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [[ "$major" == "22" ]]; then
      echo "$bin"
      return
    fi
  done

  echo "Node.js 22 required (better-sqlite3). Install node@22 or set NANOCLAW_NODE=/path/to/node22." >&2
  exit 1
}

NODE22="$(resolve_node22)"
export NANOCLAW_NODE="$NODE22"
export PATH="$(dirname "$NODE22"):$PATH"

step() { echo "[setup $(date +%H:%M:%S)] $*"; }

step "0/5 — Node.js 22 ($("$NODE22" --version) at ${NODE22})"

step "1/5 — checking Rapid-MLX at ${RAPID_MLX_URL} (model: ${RAPID_MLX_MODEL})"
if ! curl -sf "${RAPID_MLX_URL}/v1/models" >/dev/null 2>&1 && \
   ! curl -sf "${RAPID_MLX_URL}/health" >/dev/null 2>&1 && \
   ! curl -sf "${RAPID_MLX_URL}" >/dev/null 2>&1; then
  echo "Rapid-MLX does not appear to be running at ${RAPID_MLX_URL}." >&2
  echo "Start it first, e.g.: rapid-mlx serve ${RAPID_MLX_MODEL}" >&2
  exit 1
fi
echo "[setup $(date +%H:%M:%S)]   ok — Rapid-MLX reachable"

step "2/5 — checking agent container image (${CONTAINER_IMAGE})"
if ! docker image inspect "${CONTAINER_IMAGE}" >/dev/null 2>&1; then
  echo "Agent container image not found: ${CONTAINER_IMAGE}" >&2
  echo "Build it with: ./container/build.sh" >&2
  exit 1
fi
echo "[setup $(date +%H:%M:%S)]   ok — ${CONTAINER_IMAGE}"

step "3/5 — building agent-xmpp packages"
pnpm --filter @agent-xmpp/protocol build
pnpm --filter @agent-xmpp/gateway build
pnpm --filter @agent-xmpp/mcp build
echo "[setup $(date +%H:%M:%S)]   ok — packages built"

step "4/5 — launching demo (Openfire, gateway, NanoClaw host, orchestrator, agents)"
exec "$NODE22" "$ROOT/node_modules/tsx/dist/cli.mjs" packages/agent-xmpp/integration/run-local-agents-demo.ts
