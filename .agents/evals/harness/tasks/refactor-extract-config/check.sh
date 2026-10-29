#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets), SCRATCH (empty temp dir).
# Passes when the literals live only in src/config.ts and the hidden behaviour tests pass.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
cd "$W"

if [ ! -f src/config.ts ]; then
  echo "src/config.ts is missing" >&2
  exit 1
fi
leftover=$(grep -rnE 'api\.example\.test|\b5000\b|\b250\b|\b5_000\b' src --include='*.ts' | grep -v '^src/config\.ts:' || true)
if [ -n "$leftover" ]; then
  echo "hardcoded values outside src/config.ts:" >&2
  echo "$leftover" >&2
  exit 1
fi
retry_literals=$(grep -rnE 'retries: *3|\?\? *3\b' src --include='*.ts' | grep -v '^src/config\.ts:' || true)
if [ -n "$retry_literals" ]; then
  echo "hardcoded retry count outside src/config.ts:" >&2
  echo "$retry_literals" >&2
  exit 1
fi

cp -R "$CHECK_DIR/overlay/." "$W/"
bun test --timeout 20000
