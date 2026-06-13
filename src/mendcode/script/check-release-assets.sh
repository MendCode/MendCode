#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST=${1:-"$ROOT/packages/opencode/dist"}

expected=(
  mendcode-linux-arm64.tar.gz
  mendcode-linux-x64.tar.gz
  mendcode-linux-x64-baseline.tar.gz
  mendcode-linux-arm64-musl.tar.gz
  mendcode-linux-x64-musl.tar.gz
  mendcode-linux-x64-baseline-musl.tar.gz
  mendcode-darwin-arm64.zip
  mendcode-darwin-x64.zip
  mendcode-darwin-x64-baseline.zip
  mendcode-windows-arm64.zip
  mendcode-windows-x64.zip
  mendcode-windows-x64-baseline.zip
)

if [ ! -d "$DIST" ]; then
  echo "release asset directory not found: $DIST" >&2
  exit 1
fi

if find "$DIST" -maxdepth 1 -type f \( -name 'opencode-*.zip' -o -name 'opencode-*.tar.gz' \) | grep -q .; then
  echo "release assets must be MendCode-owned; found opencode-* archives:" >&2
  find "$DIST" -maxdepth 1 -type f \( -name 'opencode-*.zip' -o -name 'opencode-*.tar.gz' \) >&2
  exit 1
fi

for asset in "${expected[@]}"; do
  path="$DIST/$asset"
  if [ ! -f "$path" ]; then
    echo "missing release asset: $asset" >&2
    exit 1
  fi

  case "$asset" in
    *.tar.gz)
      if ! tar -tzf "$path" | grep -Eq '(^|/)mendcode$'; then
        echo "release asset does not contain mendcode binary: $asset" >&2
        exit 1
      fi
      ;;
    *.zip)
      if ! unzip -Z1 "$path" | grep -Eq '(^|/)mendcode(\.exe)?$'; then
        echo "release asset does not contain mendcode binary: $asset" >&2
        exit 1
      fi
      ;;
  esac
done

if [ ! -f "$DIST/SHA256SUMS" ]; then
  echo "missing SHA256SUMS" >&2
  exit 1
fi

(
  cd "$DIST"
  shasum -a 256 -c SHA256SUMS
)

echo "MendCode release asset contract OK: ${#expected[@]} archives"
