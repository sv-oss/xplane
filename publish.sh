#!/usr/bin/env bash
set -euo pipefail

# Publish all @xplane packages to npm with a specific version.
#
# Usage: ./publish.sh <version>
#   e.g. ./publish.sh 0.2.0

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

VERSION="$1"
PACKAGES=(core codegen function utils)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Publishing @xplane packages at version ${VERSION}"

# Update versions and build
for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="${ROOT_DIR}/packages/${pkg}"
  echo "--- Setting version ${VERSION} in @xplane/${pkg}"
  cd "${PKG_DIR}"
  npm version "${VERSION}" --no-git-tag-version --allow-same-version
done

cd "${ROOT_DIR}"
echo "==> Building all packages"
pnpm turbo build

# Publish in dependency order: core → codegen → function → utils
for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="${ROOT_DIR}/packages/${pkg}"
  echo "==> Publishing @xplane/${pkg}@${VERSION}"
  cd "${PKG_DIR}"
  npm publish --access public
done

echo "==> Done: published @xplane/{${PACKAGES[*]}}@${VERSION}"
