#!/bin/sh
# Installs a `mendcode-next` command that runs this checkout (development install). The released binary is `mendcode`;
# this wrapper keeps a different name so it never shadows or overwrites an installed MendCode, and tells the CLI to print
# that name in its help (MENDCODE_PROGRAM).
# It only writes ~/.local/bin/mendcode-next and never touches legacy MendCode (`mendcode`, ~/.mendcode,
# ~/.local/share/mendcode). Re-running updates the wrapper; a foreign file with that name is left alone.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${MENDCODE_NEXT_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/mendcode-next"
MARKER="# mendcode-next dev wrapper"

command -v bun >/dev/null 2>&1 || { echo "mendcode-next: bun is required (https://bun.sh)" >&2; exit 1; }
mkdir -p "$BIN_DIR"

if [ -e "$TARGET" ] && ! grep -q "$MARKER" "$TARGET" 2>/dev/null; then
  echo "mendcode-next: $TARGET exists and was not created by this script; not overwriting" >&2
  exit 1
fi

cat > "$TARGET" <<EOF
#!/bin/sh
$MARKER
exec env MENDCODE_PROGRAM=mendcode-next bun "$REPO/apps/cli/src/entry.ts" "\$@"
EOF
chmod +x "$TARGET"

echo "installed: $TARGET -> $REPO"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: add $BIN_DIR to PATH" ;;
esac
echo "run: mendcode-next            (TUI in the current directory)"
echo "     mendcode-next run \"...\"  (headless)"
echo "     mendcode-next --restart-daemon  (after updating the checkout)"
