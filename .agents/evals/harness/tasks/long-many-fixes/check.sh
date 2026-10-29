#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets),
# PRISTINE (pristine copy of the starting repo), SCRATCH (empty temp dir).
# The original test files are put back over the agent's tree, so editing a test cannot help.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
cp -R "$PRISTINE/test/." "$W/test/"
cd "$W"
bun test --timeout 20000
