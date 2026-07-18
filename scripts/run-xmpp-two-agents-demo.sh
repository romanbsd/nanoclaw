#!/usr/bin/env bash
# Run the isolated Openfire + two NanoClaw agents + Rapid-MLX demo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

resolve_node26() {
  local candidate major
  for candidate in \
    "${NANOCLAW_NODE:-}" \
    /opt/homebrew/opt/node@26/bin/node \
    /usr/local/opt/node@26/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
    if [[ "$major" == 26 ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo "Node.js 26 is required. Set NANOCLAW_NODE=/path/to/node26." >&2
  exit 1
}

NODE26="$(resolve_node26)"
export NANOCLAW_NODE="$NODE26"
export PATH="$(dirname "$NODE26"):$PATH"

run_pnpm() {
  if [[ -n "${npm_execpath:-}" && -f "$npm_execpath" ]]; then
    "$NODE26" "$npm_execpath" "$@"
  else
    pnpm "$@"
  fi
}

require_opencode_provider() {
  local missing=0
  for path in \
    src/providers/opencode.ts \
    container/agent-runner/src/providers/opencode.ts \
    container/agent-runner/src/providers/mcp-to-opencode.ts; do
    if [[ ! -f "$path" ]]; then
      echo "[demo] missing OpenCode provider file: $path" >&2
      missing=1
    fi
  done
  grep -q "import './opencode.js';" src/providers/index.ts || missing=1
  grep -q "import './opencode.js';" container/agent-runner/src/providers/index.ts || missing=1
  grep -q '"@opencode-ai/sdk"' container/agent-runner/package.json || missing=1
  grep -q '"name": "opencode-ai"' container/cli-tools.json || missing=1
  if [[ "$missing" -ne 0 ]]; then
    echo "[demo] OpenCode is an optional provider. Apply /add-opencode before running the Rapid-MLX demo." >&2
    exit 1
  fi
}

echo "[demo] Node $($NODE26 --version)"
require_opencode_provider
echo "[demo] building host and XMPP packages"
run_pnpm run build

IMAGE=$(
  "$NODE26" "$ROOT/node_modules/tsx/dist/cli.mjs" -e \
    "import { getDefaultContainerImage } from './src/install-slug.ts'; console.log(getDefaultContainerImage(process.cwd()))"
)
export CONTAINER_IMAGE="${CONTAINER_IMAGE:-$IMAGE}"

if ! docker image inspect "$CONTAINER_IMAGE" >/dev/null 2>&1 || \
   ! docker run --rm --entrypoint sh "$CONTAINER_IMAGE" -c \
      'command -v opencode >/dev/null && test -d /app/node_modules/@opencode-ai/sdk' >/dev/null 2>&1; then
  echo "[demo] rebuilding agent image with the OpenCode provider"
  ./container/build.sh
fi

exec "$NODE26" "$ROOT/node_modules/tsx/dist/cli.mjs" \
  packages/agent-xmpp/integration/run-local-agents-demo.ts
