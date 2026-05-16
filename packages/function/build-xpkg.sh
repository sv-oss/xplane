#!/usr/bin/env bash
set -euo pipefail

# Build and push the Crossplane xpkg in a single pass.
# Uses a local OCI tarball to avoid pushing the runtime image separately.
#
# Usage: ./build-xpkg.sh [TAG]
#   TAG defaults to "latest"

TAG="${1:-latest}"
REGISTRY="ghcr.io/sv-oss/function-xplane"
RUNTIME_IMAGE="${REGISTRY}-runtime:${TAG}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "==> Building runtime image: ${RUNTIME_IMAGE}"
docker build --no-cache -f "${SCRIPT_DIR}/Dockerfile" -t "${RUNTIME_IMAGE}" "${ROOT_DIR}"

echo "==> Exporting runtime image to tarball"
TARBALL=$(mktemp /tmp/xplane-runtime-XXXXXX.tar)
docker save "${RUNTIME_IMAGE}" -o "${TARBALL}"

echo "==> Building xpkg with embedded runtime tarball"
XPKG=$(mktemp /tmp/function-xplane-XXXXXX.xpkg)
crossplane xpkg build \
  --package-root="${SCRIPT_DIR}" \
  --embed-runtime-image-tarball="${TARBALL}" \
  -o "${XPKG}"

rm -f "${TARBALL}"

echo "==> Pushing xpkg: ${REGISTRY}:${TAG}"
crossplane xpkg push "${REGISTRY}:${TAG}" -f "${XPKG}"

rm -f "${XPKG}"

echo "==> Done: ${REGISTRY}:${TAG}"
