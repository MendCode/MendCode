#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets), SCRATCH (empty temp dir).
# Exit 0 only when the hidden tests pass against the agent's source.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
cp -R "$CHECK_DIR/overlay/." "$W/"
cd "$W"
bun test --timeout 20000
