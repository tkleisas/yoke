#!/usr/bin/env bash
# Installs the latest Yoke release binary for Linux/macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/tkleisas/yoke/main/scripts/install.sh | bash
set -euo pipefail

REPO="tkleisas/yoke"
VERSION="${1:-latest}"
INSTALL_DIR="${YOKE_INSTALL_DIR:-$HOME/.local/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  linux)  TARGET_OS="ubuntu-latest" ;;
  darwin) TARGET_OS="macos-latest" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p')"
fi
if [ -z "$VERSION" ]; then
  echo "Could not determine the latest version." >&2
  exit 1
fi

URL="https://github.com/$REPO/releases/download/v$VERSION/yoke-$VERSION-$TARGET_OS.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Yoke v$VERSION for $TARGET_OS..."
curl -fsSL "$URL" -o "$TMP/yoke.tar.gz"
tar -xzf "$TMP/yoke.tar.gz" -C "$TMP"

mkdir -p "$INSTALL_DIR"
install -m 755 "$TMP/yoke" "$INSTALL_DIR/yoke"
echo "Installed Yoke v$VERSION to $INSTALL_DIR/yoke"
echo "Make sure $INSTALL_DIR is on your PATH, then run: yoke"
