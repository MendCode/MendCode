#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets), SCRATCH (empty temp dir).
# The hidden tests read the sample feed from the agent's tree, so the data file is restored from pristine first.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
mkdir -p "$W/data"
cp "$CHECK_DIR/data/orders-2026-03-02.csv" "$W/data/orders-2026-03-02.csv"
cp -R "$CHECK_DIR/overlay/." "$W/"
cd "$W"
bun test --timeout 20000
