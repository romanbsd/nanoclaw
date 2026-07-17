#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${OPENFIRE_IMAGE:-clawdike-openfire:5.1.0-e2e}"

docker build \
  -f "${ROOT}/Dockerfile" \
  -t "${IMAGE}" \
  "${ROOT}" \
  "$@"

echo "Built ${IMAGE}"
