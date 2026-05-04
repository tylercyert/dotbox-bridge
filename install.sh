#!/usr/bin/env bash
#
# dotbox bridge installer
#
# Detects your OS + arch, downloads the matching prebuilt binary from the
# latest GitHub Release of tylercyert/dotbox-bridge, and drops it at
# $HOME/.local/bin/dotbox (override with DOTBOX_INSTALL_DIR=...).
#
#   curl -fsSL https://raw.githubusercontent.com/tylercyert/dotbox-bridge/main/install.sh | bash
#
set -euo pipefail

INSTALL_DIR="${DOTBOX_INSTALL_DIR:-$HOME/.local/bin}"
REPO="tylercyert/dotbox-bridge"

GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; RESET=$'\033[0m'

case "$(uname -s)" in
  Linux)  os="linux"  ;;
  Darwin) os="darwin" ;;
  *) printf "${RED}✗${RESET} Unsupported OS: $(uname -s)\n" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch="x64"   ;;
  arm64|aarch64) arch="arm64" ;;
  *) printf "${RED}✗${RESET} Unsupported arch: $(uname -m)\n" >&2; exit 1 ;;
esac

if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
  printf "${RED}✗${RESET} No prebuilt binary for linux-arm64 yet.\n" >&2
  printf "Build from source: https://github.com/${REPO}#from-source\n" >&2
  exit 1
fi

binary="dotbox-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${binary}"

printf "${GREEN}▸${RESET} Downloading %s\n" "$binary"
mkdir -p "$INSTALL_DIR"
tmp=$(mktemp)
trap 'rm -f $tmp' EXIT

if ! curl -fsSL --max-time 120 "$url" -o "$tmp"; then
  printf "${RED}✗${RESET} Download failed: %s\n" "$url" >&2
  printf "  No release published yet, or your platform isn't built.\n" >&2
  printf "  Build from source: https://github.com/${REPO}#from-source\n" >&2
  exit 1
fi

mv "$tmp" "$INSTALL_DIR/dotbox"
chmod +x "$INSTALL_DIR/dotbox"
trap - EXIT

printf "${GREEN}✓${RESET} dotbox installed to %s/dotbox\n" "$INSTALL_DIR"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    printf "  Run \`dotbox help\` to see commands.\n"
    ;;
  *)
    printf "${YELLOW}⚠${RESET} %s is not on your PATH. Add it with:\n" "$INSTALL_DIR"
    printf "    echo 'export PATH=\"%s:\$PATH\"' >> ~/.bashrc\n" "$INSTALL_DIR"
    printf "    source ~/.bashrc\n"
    ;;
esac
