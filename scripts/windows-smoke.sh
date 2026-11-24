#!/usr/bin/env bash
# Windows smoke (windows-smoke.yml): runs the built mendcode.exe the way a user's machine does and keeps every log.
# usage: windows-smoke.sh <path to mendcode.exe> <work dir>
set -u
EXE=$1
WORK=$2
LOGS="$WORK/logs"
mkdir -p "$LOGS" "$WORK/home"
export HOME="$WORK/home" USERPROFILE="$WORK/home" MENDCODE_V2_ENGINE=faux MENDCODE_CLAUDE=0
fail=0
step() { echo "::group::$1"; }
end() { echo "::endgroup::"; }

# 1. The daemon started explicitly in the background: does it start, and what does it print?
step "daemon (explicit __daemon)"
DATA="$WORK/explicit"
"$EXE" __daemon --dir "$DATA" --engine faux --cwd "$WORK" >"$LOGS/daemon-explicit.out" 2>"$LOGS/daemon-explicit.err" &
DPID=$!
for _ in $(seq 1 60); do
  [ -s "$LOGS/daemon-explicit.out" ] && break
  kill -0 "$DPID" 2>/dev/null || break
  sleep 0.5
done
echo "--- stdout"; cat "$LOGS/daemon-explicit.out"
echo "--- stderr"; cat "$LOGS/daemon-explicit.err"
echo "--- data dir"; ls -la "$DATA" 2>&1
if kill -0 "$DPID" 2>/dev/null; then echo "daemon process alive"; else echo "daemon process EXITED"; fail=1; fi
end

step "daemon status against it"
"$EXE" --dir "$DATA" daemon status --json >"$LOGS/status-explicit.out" 2>"$LOGS/status-explicit.err"; code=$?
cat "$LOGS/status-explicit.out" "$LOGS/status-explicit.err"; echo "exit $code"
[ "$code" = 0 ] || fail=1
end

step "session create against it"
"$EXE" --dir "$DATA" session create --compat mendcode.cli.v1 >"$LOGS/session-explicit.out" 2>"$LOGS/session-explicit.err"; code=$?
cat "$LOGS/session-explicit.out" "$LOGS/session-explicit.err"; echo "exit $code"
[ "$code" = 0 ] || fail=1
end

step "daemon stop"
"$EXE" --dir "$DATA" daemon stop --force >"$LOGS/stop-explicit.out" 2>&1; echo "exit $?"; cat "$LOGS/stop-explicit.out"
sleep 2; kill "$DPID" 2>/dev/null
end

# 2. What a user does: no daemon running, a command that needs one starts it detached.
step "auto-started daemon (a command with no daemon running)"
AUTO="$WORK/auto"
"$EXE" --dir "$AUTO" session create --compat mendcode.cli.v1 >"$LOGS/session-auto.out" 2>"$LOGS/session-auto.err"; code=$?
cat "$LOGS/session-auto.out" "$LOGS/session-auto.err"; echo "exit $code"
[ "$code" = 0 ] || fail=1
echo "--- data dir"; ls -la "$AUTO" 2>&1
"$EXE" --dir "$AUTO" daemon status --json >"$LOGS/status-auto.out" 2>"$LOGS/status-auto.err"; echo "status exit $?"; cat "$LOGS/status-auto.out" "$LOGS/status-auto.err"
"$EXE" --dir "$AUTO" daemon stop --force >"$LOGS/stop-auto.out" 2>&1; cat "$LOGS/stop-auto.out"
end

# 3. The default engine and the default data directory under a user profile, with the daemon's own stderr shown and timed.
step "default engine, default data dir (what a user's first command does)"
unset MENDCODE_V2_ENGINE MENDCODE_CLAUDE
DEFAULTDIR="$HOME/.mendcode"
start=$(date +%s%N)
"$EXE" --print-logs --log-level DEBUG session create --compat mendcode.cli.v1 >"$LOGS/session-default.out" 2>"$LOGS/session-default.err"; code=$?
echo "elapsed ms: $(( ($(date +%s%N) - start) / 1000000 ))  exit $code"
cat "$LOGS/session-default.out"; echo "--- stderr"; cat "$LOGS/session-default.err"
[ "$code" = 0 ] || fail=1
echo "--- data dir"; ls -la "$DEFAULTDIR" 2>&1
"$EXE" daemon stop --force 2>&1
end

step "daemon start (the explicit command)"
start=$(date +%s%N)
"$EXE" --print-logs daemon start >"$LOGS/start-default.out" 2>"$LOGS/start-default.err"; code=$?
echo "elapsed ms: $(( ($(date +%s%N) - start) / 1000000 ))  exit $code"
cat "$LOGS/start-default.out"; echo "--- stderr"; cat "$LOGS/start-default.err"
[ "$code" = 0 ] || fail=1
"$EXE" daemon stop --force 2>&1
end

# 4. A lock left by a daemon that died uncleanly (reboot, Task Manager) whose pid now belongs to an unrelated process:
# Windows reuses pids quickly, so this is what the next start after a reboot can meet.
step "stale mendd.lock whose pid was recycled by another process"
STALE="$WORK/stale"
mkdir -p "$STALE"
sleep 600 &
OTHER=$!
OTHER_WIN=$(cat "/proc/$OTHER/winpid" 2>/dev/null || echo "$OTHER")
printf '%s' "$OTHER_WIN" >"$STALE/mendd.lock"
touch -d '2 hours ago' "$STALE/mendd.lock"
echo "lock names pid $OTHER_WIN (a sleep process), written 2 hours ago"
start=$(date +%s%N)
"$EXE" --dir "$STALE" session create --compat mendcode.cli.v1 >"$LOGS/session-stale.out" 2>"$LOGS/session-stale.err"; code=$?
echo "elapsed ms: $(( ($(date +%s%N) - start) / 1000000 ))  exit $code"
cat "$LOGS/session-stale.out"; echo "--- stderr"; cat "$LOGS/session-stale.err"
[ "$code" = 0 ] || { echo "STALE LOCK: the daemon did not start"; fail=1; }
"$EXE" --dir "$STALE" daemon stop --force 2>&1
kill "$OTHER" 2>/dev/null
end

# 5. `mendcode upgrade` run by the installed program itself replaces that running mendcode.exe with a published release
# (SMOKE_UPGRADE_TO names it; empty skips this step).
if [ -n "${SMOKE_UPGRADE_TO:-}" ]; then
  step "upgrade the running mendcode.exe to $SMOKE_UPGRADE_TO"
  INSTALL="$WORK/install"
  UPDATA="$WORK/updata"
  mkdir -p "$INSTALL"
  cp "$EXE" "$INSTALL/mendcode.exe"
  printf 'schema=mendcode.install.v1\nbinary=mendcode.exe\nsha256=%s\ntier=balanced\n' "$(sha256sum "$INSTALL/mendcode.exe" | tr -d '\\' | cut -d' ' -f1)" >"$INSTALL/.mendcode-install"
  echo "--- before: $("$INSTALL/mendcode.exe" --version 2>&1)"
  "$INSTALL/mendcode.exe" upgrade "$SMOKE_UPGRADE_TO" --force --dir "$UPDATA" >"$LOGS/upgrade.out" 2>"$LOGS/upgrade.err"; code=$?
  cat "$LOGS/upgrade.out" "$LOGS/upgrade.err"; echo "exit $code"
  [ "$code" = 0 ] || fail=1
  echo "--- install dir"; ls -la "$INSTALL"
  [ -e "$INSTALL/mendcode.exe.old" ] || { echo "no mendcode.exe.old after the swap"; fail=1; }
  [ -e "$INSTALL/mendcode.exe.new" ] && { echo "staging file left behind"; fail=1; }
  after=$("$INSTALL/mendcode.exe" --version 2>&1); echo "--- after: $after"
  case "$after" in "${SMOKE_UPGRADE_TO#v}"*) ;; *) echo "the replaced program does not report $SMOKE_UPGRADE_TO"; fail=1 ;; esac
  echo "--- receipt"; cat "$INSTALL/.mendcode-install"
  want=$(sha256sum "$INSTALL/mendcode.exe" | tr -d '\\' | cut -d' ' -f1)
  grep -q "sha256=$want" "$INSTALL/.mendcode-install" || { echo "receipt digest differs from the installed program"; fail=1; }
  end

  # The released program that replaced this one predates the cleanup, so the cleanup is checked on the built program itself.
  step "the next start removes mendcode.exe.old"
  CLEAN="$WORK/cleanup"
  mkdir -p "$CLEAN"
  cp "$EXE" "$CLEAN/mendcode.exe"
  echo "replaced program" >"$CLEAN/mendcode.exe.old"
  "$CLEAN/mendcode.exe" --version
  [ -e "$CLEAN/mendcode.exe.old" ] && { echo "mendcode.exe.old was not removed at the next start"; fail=1; }
  end
fi

cp -r "$DATA" "$LOGS/data-explicit" 2>/dev/null
cp -r "$AUTO" "$LOGS/data-auto" 2>/dev/null
exit $fail
