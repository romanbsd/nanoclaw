#!/usr/bin/env bash
# Run the isolated Openfire + two NanoClaw agents + Rapid-MLX demo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

resolve_node22() {
  local candidate major
  for candidate in \
    "${NANOCLAW_NODE:-}" \
    /opt/homebrew/opt/node@22/bin/node \
    /usr/local/opt/node@22/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
    if [[ "$major" == 22 ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo "Node.js 22 is required. Set NANOCLAW_NODE=/path/to/node22." >&2
  exit 1
}

NODE22="$(resolve_node22)"
export NANOCLAW_NODE="$NODE22"
export PATH="$(dirname "$NODE22"):$PATH"

run_pnpm() {
  if [[ -n "${npm_execpath:-}" && -f "$npm_execpath" ]]; then
    "$NODE22" "$npm_execpath" "$@"
  else
    pnpm "$@"
  fi
}

echo "[demo] Node $($NODE22 --version)"
echo "[demo] building host and XMPP packages"
run_pnpm run build

IMAGE=$(
  "$NODE22" "$ROOT/node_modules/tsx/dist/cli.mjs" -e \
    "import { getDefaultContainerImage } from './src/install-slug.ts'; console.log(getDefaultContainerImage(process.cwd()))"
)
export CONTAINER_IMAGE="${CONTAINER_IMAGE:-$IMAGE}"

if ! docker image inspect "$CONTAINER_IMAGE" >/dev/null 2>&1 || \
   ! docker run --rm --entrypoint sh "$CONTAINER_IMAGE" -c \
      'command -v opencode >/dev/null && test -d /app/node_modules/@opencode-ai/sdk' >/dev/null 2>&1; then
  echo "[demo] rebuilding agent image with the OpenCode provider"
  ./container/build.sh
fi

exec "$NODE22" "$ROOT/node_modules/tsx/dist/cli.mjs" \
  packages/agent-xmpp/integration/run-local-agents-demo.ts
