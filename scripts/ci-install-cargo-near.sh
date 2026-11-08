#!/usr/bin/env bash
# Install the pinned cargo-near release in CI (GITHUB_TOKEN required). GitHub's release download URLs
# can return 504 for long stretches while its API still serves the same asset, so each attempt tries
# both. The tarball's sha256 is pinned, and this step fails by itself if cargo-near never lands.

set -euo pipefail

TARBALL=cargo-near-x86_64-unknown-linux-gnu.tar.gz
RELEASE_URL="https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/$TARBALL"
ASSET_URL=https://api.github.com/repos/near/cargo-near/releases/assets/477230462
SHA256=9429064e30a427e96523f539cb255f3688d2345e5000d7d4e4873a8247247d1a
ATTEMPTS=6

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  curl --proto '=https' --tlsv1.2 -LsSf -m 120 "$RELEASE_URL" -o "$tmp/$TARBALL" \
    || curl --proto '=https' --tlsv1.2 -LsSf -m 120 -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H 'Accept: application/octet-stream' "$ASSET_URL" -o "$tmp/$TARBALL"
}

install_binary() {
  echo "$SHA256  $tmp/$TARBALL" | sha256sum -c - \
    && mkdir -p "${CARGO_HOME:-$HOME/.cargo}/bin" \
    && tar xzf "$tmp/$TARBALL" -C "${CARGO_HOME:-$HOME/.cargo}/bin" --strip-components=1 "${TARBALL%.tar.gz}/cargo-near"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if fetch && install_binary && cargo near --version; then
    exit 0
  fi
  echo "ci-install-cargo-near: attempt $attempt of $ATTEMPTS failed" >&2
  if [ "$attempt" -lt "$ATTEMPTS" ]; then sleep $((attempt * 20)); fi
done

echo "ci-install-cargo-near: cargo-near was not installed" >&2
exit 1
