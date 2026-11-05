#!/usr/bin/env bash
# Print the path of a verified near-sandbox binary (nearcore 2.14.0, the version the contract's
# near-sdk 5.30 targets and the Rust sandbox suite runs), downloading it once into a cache.
#
# The tarball's sha256 is pinned per platform, so a tampered or swapped download is refused —
# near-sandbox's own downloader does no integrity check. Set NEAR_SANDBOX_TARBALL to use a
# tarball you already have (it is verified the same way).
#
#   export NEAR_SANDBOX_BIN_PATH="$(scripts/sandbox-bin.sh)"

set -euo pipefail

VERSION=2.14.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=Darwin-arm64; SHA256=ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232 ;;
  Linux-x86_64) PLATFORM=Linux-x86_64; SHA256=a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691 ;;
  *) echo "sandbox-bin: no pinned near-sandbox build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

CACHE="${PURSER_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/purser}/near-sandbox-$VERSION-$PLATFORM"
BIN="$CACHE/near-sandbox"

if [ ! -x "$BIN" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if [ -n "${NEAR_SANDBOX_TARBALL:-}" ]; then
    cp "$NEAR_SANDBOX_TARBALL" "$tmp/sandbox.tgz"
  else
    echo "sandbox-bin: downloading nearcore $VERSION sandbox for $PLATFORM (once)" >&2
    curl --proto '=https' --tlsv1.2 -sSfL --retry 3 -o "$tmp/sandbox.tgz" \
      "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$PLATFORM/$VERSION/near-sandbox.tar.gz"
  fi
  actual="$( (sha256sum "$tmp/sandbox.tgz" 2>/dev/null || shasum -a 256 "$tmp/sandbox.tgz") | cut -d' ' -f1)"
  if [ "$actual" != "$SHA256" ]; then
    echo "sandbox-bin: sha256 mismatch for the $PLATFORM tarball (got $actual, pinned $SHA256) — refusing" >&2
    exit 1
  fi
  tar -xzf "$tmp/sandbox.tgz" -C "$tmp"
  mkdir -p "$CACHE"
  install -m 0755 "$tmp/$PLATFORM/near-sandbox" "$BIN"
fi

echo "$BIN"
