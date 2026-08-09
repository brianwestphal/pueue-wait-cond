#!/usr/bin/env bash
#
# Install the `pueue` + `pueued` binaries for the current platform.
#
#   .github/scripts/install-pueue.sh [DEST_DIR] [VERSION]
#
# Defaults: DEST_DIR=$HOME/.local/bin, VERSION=latest.
#
# Uses the prebuilt release binaries rather than `cargo install`, which takes
# minutes on a cold CI runner. Both binaries are needed: `pueued` runs the tasks,
# `pueue` is what pueue-wait-cond shells out to.
set -euo pipefail

DEST="${1:-$HOME/.local/bin}"
VERSION="${2:-latest}"
REPO="Nukesor/pueue"

os="$(uname -s)"
arch="$(uname -m)"

case "${os}/${arch}" in
  Linux/x86_64)          target="x86_64-unknown-linux-musl" ;;
  Linux/aarch64|Linux/arm64) target="aarch64-unknown-linux-musl" ;;
  Darwin/arm64)          target="aarch64-apple-darwin" ;;
  Darwin/x86_64)         target="x86_64-apple-darwin" ;;
  *)
    echo "install-pueue: unsupported platform ${os}/${arch}" >&2
    echo "  pueue publishes: linux musl (x86_64/aarch64/arm/armv7), macOS (x86_64/arm64)," >&2
    echo "  freebsd and windows. See https://github.com/${REPO}/releases" >&2
    exit 1
    ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

mkdir -p "$DEST"
for bin in pueue pueued; do
  url="${base}/${bin}-${target}"
  echo "install-pueue: fetching ${url}"
  # --fail so a 404 is an error rather than an HTML page written to the binary.
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
       --output "${DEST}/${bin}" "$url"
  chmod +x "${DEST}/${bin}"
done

export PATH="${DEST}:${PATH}"
echo "install-pueue: installed to ${DEST}"
"${DEST}/pueue" --version
"${DEST}/pueued" --version

# Make it available to later steps when running under GitHub Actions.
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$DEST" >> "$GITHUB_PATH"
fi
