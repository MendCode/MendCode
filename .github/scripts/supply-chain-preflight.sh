#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

failures=()

add_failure() {
  failures+=("$1")
}

while IFS= read -r -d '' file; do
  case "$file" in
    .git/*|*/node_modules/*|*/dist/*) continue ;;
  esac
  if LC_ALL=C grep -nP '[\x{200B}\x{200C}\x{200D}\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]' "$file" >/tmp/mendcode-invisible.$$ 2>/dev/null; then
    add_failure "Invisible Unicode control found in $file"
    cat /tmp/mendcode-invisible.$$ >&2 || true
  fi
done < <(git ls-files -z)
rm -f /tmp/mendcode-invisible.$$

if git ls-files -z | grep -zE '(^|/)\.env($|\.)|(^|/).*\.(pem|key|p12|pfx)$' | grep -zvE '\.env\.example$' >/tmp/mendcode-risky-files.$$; then
  add_failure "Risky secret-like tracked file path found"
  tr '\0' '\n' </tmp/mendcode-risky-files.$$ >&2
fi
rm -f /tmp/mendcode-risky-files.$$

while IFS= read -r -d '' file; do
  while IFS= read -r line; do
    ref=$(printf '%s\n' "$line" | sed -E 's/^.*uses:[[:space:]]*[^@]+@([^[:space:]#'\''"]+).*$/\1/')
    case "$ref" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
        ;;
      *)
        add_failure "Workflow action is not pinned to a full commit SHA: $file :: $line"
        ;;
    esac
  done < <(grep -nE 'uses: [^[:space:]#]+@' "$file" | grep -vE 'uses: docker://' || true)
done < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)

if grep -RInP 'curl .*\| *(bash|sh)|wget .*\| *(bash|sh)' .github src/mendcode/script src/mendcode/packages/opencode/script 2>/dev/null; then
  add_failure "Pipe-to-shell command found in automation path"
fi

if git ls-files | grep -E '(^|/)opencode-.*\.(zip|tar\.gz)$' | grep -v '^src/mendcode/packages/opencode/dist/' >/dev/null; then
  add_failure "Found opencode-named release archive outside ignored dist output"
fi

if [ "${#failures[@]}" -gt 0 ]; then
  printf 'Supply-chain preflight failed:\n' >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi

echo "Supply-chain preflight OK"
