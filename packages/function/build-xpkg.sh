#!/usr/bin/env bash
set -euo pipefail

# Build and push a multiplatform (arm64 + amd64) Crossplane xpkg.
#
# Usage: ./build-xpkg.sh [--no-push] [TAG]
#   TAG defaults to "latest"

PUSH=true
if [[ "${1:-}" == "--no-push" ]]; then
  PUSH=false
  shift
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="ghcr.io/sv-oss/function-xplane"
PLATFORMS=("linux/amd64" "linux/arm64")
BUILD_CONTEXT="${SCRIPT_DIR}/bundle"

if [[ -n "${1:-}" ]]; then
  TAG="${1}"
else
  TAG="v$(jq -r .version "${SCRIPT_DIR}/package.json")"
fi

TMPDIR=$(mktemp -d /tmp/xplane-build-XXXXXX)
trap 'rm -rf "${TMPDIR}"' EXIT

for PLATFORM in "${PLATFORMS[@]}"; do
  ARCH="${PLATFORM#*/}"
  echo "==> Building runtime image for ${PLATFORM}"

  TARBALL="${TMPDIR}/runtime-${ARCH}.tar"
  docker buildx build \
    --no-cache \
    --platform="${PLATFORM}" \
    --output="type=docker,dest=${TARBALL}" \
    -f "${SCRIPT_DIR}/Dockerfile" \
    "${BUILD_CONTEXT}"

  echo "==> Building xpkg for ${ARCH}"
  XPKG="${TMPDIR}/function-xplane-${ARCH}.xpkg"
  crossplane xpkg build \
    --package-root="${SCRIPT_DIR}" \
    --embed-runtime-image-tarball="${TARBALL}" \
    -o "${XPKG}"
done

if [[ "${PUSH}" == "true" ]]; then
  XPKG_FILES="$(echo "${TMPDIR}"/*.xpkg | tr ' ' ,)"

  echo "==> Pushing multiplatform xpkg: ${REGISTRY}:${TAG}"
  crossplane --verbose xpkg push --package-files "${XPKG_FILES}" "${REGISTRY}:${TAG}"

  echo "==> Pushing multiplatform xpkg: ${REGISTRY}:latest"
  crossplane --verbose xpkg push --package-files "${XPKG_FILES}" "${REGISTRY}:latest"

  echo "==> Done: ${REGISTRY}:${TAG} and ${REGISTRY}:latest"
else
  echo "==> Built packages (push skipped):"
  ls -lh "${TMPDIR}"/*.xpkg
fi
