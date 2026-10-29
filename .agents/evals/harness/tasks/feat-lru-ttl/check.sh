#!/usr/bin/env bash
# Runs outside the agent's directory. Env: WORK (the agent's final tree), CHECK_DIR (pristine assets), SCRATCH (empty temp dir).
# Passes only when (1) the agent added tests of its own, (2) its own suite is green, (3) the hidden suite is green.
set -eu
W="$SCRATCH/w"
mkdir -p "$W"
tar -C "$WORK" --exclude=.git --exclude=node_modules -cf - . | tar -C "$W" -xf -
cd "$W"

baseline=$(tr -d '[:space:]' < "$CHECK_DIR/baseline-test-count.txt")
cases=$(grep -rEh '^[[:space:]]*(test|it)(\.[a-z]+)?\(' test | wc -l | tr -d '[:space:]')
if [ "$cases" -le "$baseline" ]; then
  echo "no new test cases were added ($cases <= $baseline)" >&2
  exit 1
fi

bun test --timeout 20000
cp -R "$CHECK_DIR/overlay/." "$W/"
bun test --timeout 20000
