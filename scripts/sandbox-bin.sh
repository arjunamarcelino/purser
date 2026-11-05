#!/usr/bin/env bash
# Print the path of a verified near-sandbox binary (nearcore 2.14.0, the version the contract's
# near-sdk 5.30 targets and the Rust sandbox suite runs), downloading it once into a cache.
#
# The tarball's and the binary's sha256 are pinned per platform: a tampered download is refused,
# and so is a cached binary that changed since (checked on every call, including a CI cache
# restore). near-sandbox's own downloader does no integrity check. Set NEAR_SANDBOX_TARBALL to use
# a tarball you already have (verified the same way).
#
#   export NEAR_SANDBOX_BIN_PATH="$(scripts/sandbox-bin.sh)"

set -euo pipefail

VERSION=2.14.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=Darwin-arm64
    SHA256=ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232
    BIN_SHA256=8e0e1521372b0fce801b7464078c1e95e5a25a0f92ad4b4241451c33fe9e5a2a ;;
  Linux-x86_64) PLATFORM=Linux-x86_64
    SHA256=a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691
    BIN_SHA256=797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13 ;;
  *) echo "sandbox-bin: no pinned near-sandbox build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

sha256() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }

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
  actual="$(sha256 "$tmp/sandbox.tgz")"
  if [ "$actual" != "$SHA256" ]; then
    echo "sandbox-bin: sha256 mismatch for the $PLATFORM tarball (got $actual, pinned $SHA256) — refusing" >&2
    exit 1
  fi
  tar -xzf "$tmp/sandbox.tgz" -C "$tmp"
  mkdir -p "$CACHE"
  install -m 0755 "$tmp/$PLATFORM/near-sandbox" "$BIN"
fi

if [ "$(sha256 "$BIN")" != "$BIN_SHA256" ]; then
  echo "sandbox-bin: cached binary $BIN does not match the pinned sha256 — delete it and re-run" >&2
  exit 1
fi
echo "$BIN"
