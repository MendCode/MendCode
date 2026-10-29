#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets), SCRATCH (empty temp dir).
# Exactly one constant (the checkout payment call's) must have changed to 25000; every other timeout must be untouched.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
cd "$W"
bun "$CHECK_DIR/verify.ts" "$W"
bun test --timeout 20000
