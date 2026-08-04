#!/usr/bin/env bash

mendcode_release_temp_cleanup_release_dir() {
  local dir="${MENDCODE_RELEASE_DIR:-}"
  if [ -z "$dir" ]; then
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)" || return 1
  fi
  (cd "$dir" 2>/dev/null && pwd -P)
}

mendcode_release_temp_cleanup_root_dir() {
  local root="${MENDCODE_RELEASE_TEMP_ROOT:-}"
  if [ -z "$root" ]; then
    [ -n "${TMPDIR:-}" ] || return 1
    root="${TMPDIR%/}/mendcode"
  fi
  (cd "$root" 2>/dev/null && pwd -P)
}

mendcode_release_temp_cleanup_workspace() {
  local release_dir temp_root workspace suffix
  release_dir="$(mendcode_release_temp_cleanup_release_dir)" || return 1
  temp_root="$(mendcode_release_temp_cleanup_root_dir)" || return 1

  case "$release_dir" in
    "$temp_root"/*/src/mendcode) ;;
    *) return 1 ;;
  esac

  workspace="${release_dir%/src/mendcode}"
  suffix="${workspace#"$temp_root"/}"
  [ -n "$suffix" ] || return 1
  case "$suffix" in
    */*|.|..) return 1 ;;
  esac
  [ -f "$release_dir/script/release" ] || return 1
  [ -f "$release_dir/package.json" ] || return 1
  printf '%s\n' "$workspace"
}

mendcode_release_temp_cleanup_marker_value() {
  local marker="$1" want="$2" key value
  [ -f "$marker" ] || return 1
  while IFS='=' read -r key value; do
    if [ "$key" = "$want" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < "$marker"
  return 1
}

mendcode_release_temp_cleanup_marker_owner_active() {
  local pid
  pid="$(mendcode_release_temp_cleanup_marker_value "$1" pid 2>/dev/null)" || return 1
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

mendcode_release_temp_cleanup_arm() {
  local workspace marker existing_token
  workspace="$(mendcode_release_temp_cleanup_workspace)" || return 0
  marker="$workspace/.mendcode-release-cleanup-owner"
  if [ -L "$marker" ] || { [ -e "$marker" ] && [ ! -f "$marker" ]; }; then
    printf 'release cleanup: refusing unsafe owner marker: %s\n' "$marker" >&2
    return 1
  fi
  existing_token="$(mendcode_release_temp_cleanup_marker_value "$marker" token 2>/dev/null || true)"
  : "${MENDCODE_RELEASE_TEMP_CLEANUP_TOKEN:=$$:${BASHPID:-$$}:${RANDOM:-0}}"

  if [ -f "$marker" ] && [ "$existing_token" != "$MENDCODE_RELEASE_TEMP_CLEANUP_TOKEN" ] && mendcode_release_temp_cleanup_marker_owner_active "$marker"; then
    printf 'release cleanup: refusing active temp workspace: %s\n' "$workspace" >&2
    return 1
  fi

  {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$MENDCODE_RELEASE_TEMP_CLEANUP_TOKEN"
    printf 'workspace=%s\n' "$workspace"
  } > "$marker"
}

mendcode_release_temp_cleanup_node_modules() {
  local workspace
  workspace="$(mendcode_release_temp_cleanup_workspace)" || return 1
  printf '%s\n' "$workspace/src/mendcode/node_modules"
}

mendcode_release_temp_cleanup() {
  local workspace marker token deps
  workspace="$(mendcode_release_temp_cleanup_workspace)" || return 0
  marker="$workspace/.mendcode-release-cleanup-owner"
  if [ -L "$marker" ] || { [ -e "$marker" ] && [ ! -f "$marker" ]; }; then
    printf 'release cleanup: refusing unsafe owner marker: %s\n' "$marker" >&2
    return 1
  fi
  token="$(mendcode_release_temp_cleanup_marker_value "$marker" token 2>/dev/null || true)"
  [ -n "${MENDCODE_RELEASE_TEMP_CLEANUP_TOKEN:-}" ] || return 0
  [ "$token" = "$MENDCODE_RELEASE_TEMP_CLEANUP_TOKEN" ] || return 0

  deps="$workspace/src/mendcode/node_modules"
  if [ ! -e "$deps" ] && [ ! -L "$deps" ]; then
    rm -f -- "$marker"
    return 0
  fi
  case "$deps" in
    "$workspace"/src/mendcode/node_modules) ;;
    *)
      printf 'release cleanup: refusing unsafe node_modules path: %s\n' "$deps" >&2
      return 1
      ;;
  esac
  if [ -L "$deps" ] || [ ! -d "$deps" ]; then
    printf 'release cleanup: refusing non-directory node_modules path: %s\n' "$deps" >&2
    return 1
  fi

  rm -rf -- "$deps"
  rm -f -- "$marker"
}

mendcode_release_temp_cleanup_exit() {
  local status=$?
  trap - EXIT
  if ! mendcode_release_temp_cleanup && [ "$status" -eq 0 ]; then
    status=1
  fi
  exit "$status"
}

mendcode_release_temp_cleanup_install_trap() {
  trap mendcode_release_temp_cleanup_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-cleanup}" in
    arm) mendcode_release_temp_cleanup_arm ;;
    cleanup) mendcode_release_temp_cleanup ;;
    node-modules) mendcode_release_temp_cleanup_node_modules ;;
    *)
      printf 'Usage: %s [arm|cleanup|node-modules]\n' "$0" >&2
      exit 2
      ;;
  esac
fi
