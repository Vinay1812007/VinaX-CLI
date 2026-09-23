#!/bin/sh
# VinaX installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.sh | sh
#
# Downloads the standalone `vinax` binary for this machine from GitHub Releases, checks it against
# the release's SHA256SUMS and installs it. Environment variables:
#   VINAX_VERSION       version to install, e.g. 0.2.0 (default: latest)
#   VINAX_INSTALL_DIR   where to put the binary (default: ~/.vinax/bin)
#   VINAX_DOWNLOAD_BASE download from this URL instead of GitHub (mirrors, testing)
set -eu

REPO="Vinay1812007/VinaX-CLI"
VERSION="${VINAX_VERSION:-latest}"
INSTALL_DIR="${VINAX_INSTALL_DIR:-$HOME/.vinax/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'vinax install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/scripts/install.ps1 | iex" ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

# An x64 shell on Apple silicon (Rosetta) should still get the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

target="$os-$arch"
if [ "$os" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
  target="$target-musl"
fi
asset="vinax-$target"

if [ -n "${VINAX_DOWNLOAD_BASE:-}" ]; then
  base="${VINAX_DOWNLOAD_BASE%/}"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION)…"
fetch "$base/$asset" "$tmp/vinax" || fail "could not download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

expected="$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "SHA256SUMS does not list $asset"
actual="$(sha256 "$tmp/vinax")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/vinax"
mv -f "$tmp/vinax" "$INSTALL_DIR/vinax"
installed="$("$INSTALL_DIR/vinax" --version 2>/dev/null || echo '?')"
say "✔ Installed VinaX $installed to $INSTALL_DIR/vinax"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) say "Run: vinax" ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      */fish) rc="" ;;
      *) rc="$HOME/.profile" ;;
    esac
    say ""
    say "$INSTALL_DIR is not on your PATH yet. Add it with:"
    if [ -z "$rc" ]; then
      say "  fish_add_path $INSTALL_DIR"
    else
      say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $rc && . $rc"
    fi
    say "Then run: vinax"
    ;;
esac
