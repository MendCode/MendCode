#!/bin/sh
# Installs a `mendcode` command that runs this checkout (development install).
# It only writes ~/.local/bin/mendcode (MENDCODE_BIN_DIR to choose the folder) and never overwrites a `mendcode` it did not
# write, such as an installed release. Re-running updates the wrapper.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${MENDCODE_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/mendcode"
MARKER="# mendcode dev wrapper"

command -v bun >/dev/null 2>&1 || { echo "mendcode: bun is required (https://bun.sh)" >&2; exit 1; }
mkdir -p "$BIN_DIR"

if [ -e "$TARGET" ] && ! grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "mendcode: $TARGET exists and was not created by this script; not overwriting (set MENDCODE_BIN_DIR for another folder)" >&2
  exit 1
fi

cat > "$TARGET" <<WRAPPER
#!/bin/sh
$MARKER
exec bun "$REPO/apps/cli/src/entry.ts" "\$@"
WRAPPER
chmod +x "$TARGET"

echo "installed: $TARGET -> $REPO"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: add $BIN_DIR to PATH" ;;
esac
echo "run: mendcode            (TUI in the current directory)"
echo "     mendcode run \"...\"  (headless)"
echo "     mendcode --restart-daemon  (after updating the checkout)"
