#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets), SCRATCH (empty temp dir).
# Passes when the helper moved and was renamed everywhere, and the hidden behaviour tests pass.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
cd "$W"

if grep -rnw "fmtMoney" src test; then
  echo "leftover references to fmtMoney" >&2
  exit 1
fi
if [ ! -f src/money/format.ts ]; then
  echo "src/money/format.ts is missing" >&2
  exit 1
fi
if grep -q "formatMoney" src/util.ts; then
  echo "the helper must live in src/money/format.ts, not src/util.ts" >&2
  exit 1
fi

cp -R "$CHECK_DIR/overlay/." "$W/"
bun test --timeout 20000
