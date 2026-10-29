#!/bin/sh
# Runs the whole test suite as separate processes, one after another, so memory is released between parts.
# One `bun test` over every file keeps all of them in one process and grows past 6 GB (the first release run on a CI runner
# spent 18 minutes in it and was cancelled with 567 of 972 files not started), so CI and developers both use this script.
#
# usage: sh scripts/test-shards.sh [part ...]     parts: cli daemon packages rest (default: all, in that order)
#   exit 1 when any part fails (a failing, timed-out or crashed part fails the run; later parts still run so one run shows everything)
# Prints, per part: its duration and pass/fail counts; per failure: the file, the test name and what bun printed for it
# (code frame, error, Expected/Received, stack); for a part that crashed or timed out without a parsable failure: the last 60 lines.
#
# environment (all optional; unset locally):
#   MENDCODE_TEST_TIME_SCALE   a number >= 1: time budgets in tests are multiplied by it (scripts/test-budget.ts) and bun's default
#                              per-test timeout (5 s) is raised by the same factor. The CI workflows set it; developers do not.
#   MENDCODE_TEST_PART_SECONDS a wall-clock limit per part (needs `timeout`, i.e. Linux CI): a hung part is killed, reported with the
#                              tail of its output, and fails the run instead of silently using up the whole job.
#   MENDCODE_TEST_LOG_DIR      keep each part's complete output as <dir>/<part>.log (the workflow uploads it whatever the outcome, also when the
#                              job is cancelled).
#   MENDCODE_TEST_HEARTBEAT_SECONDS  every N seconds print one line: the part, seconds in, load, memory available, the biggest process
#                              and the test file the part is in. When a run is cancelled or killed, the last such line says what it was doing
#                              and whether the machine was out of memory (the second release run was cancelled 146 s into a part, with nothing
#                              printed about why).
#   MENDCODE_TEST_NEW_SESSION  1: run every part in a session of its own (`setsid`, Linux), so a signal aimed at a process group or a session
#                              from inside the tests can only reach the part, never this script or the CI runner's step.
#   MENDCODE_TEST_SILENCE_SECONDS  a part that prints nothing for this long is hung (default 300, times MENDCODE_TEST_TIME_SCALE; 0 turns it
#                              off): the script prints the test file it is in, the part's processes and, on macOS, where the bun process
#                              is (`sample`), kills the part and fails the run. A run once sat in `packages` for 26 minutes and was killed
#                              by hand with nothing to say which file it was; three later runs of the part did not hang. bun's own
#                              per-test timeout cannot end a test that blocks without returning to the event loop.
# bun prints only failures when it believes an AI agent started it (CLAUDECODE, AGENT, REPL_ID): then no log names the file a part is in.
# The script unsets the three, so the logs, the heartbeat's `last=` and the silence check are the same whoever starts the run.
# A SIGTERM, SIGINT or SIGHUP that arrives at this script is reported (which signal, in which part, in which test file, the process table,
# memory, and kernel out-of-memory lines when they can be read) before the script exits with 128 plus the signal number. The shell runs the
# handler once the part that is running has ended, which is at once when the signal went to the whole group.
set -u
unset CLAUDECODE AGENT REPL_ID
cd "$(dirname "$0")/.."
others=$(ls -d packages/*/ | grep -v '^packages/daemon/$' | tr '\n' ' ')
apps=$(ls -d apps/*/ | grep -v '^apps/cli/$' | tr '\n' ' ')
failed=0
part_label=""
bun_timeout=""
if [ -n "${MENDCODE_TEST_TIME_SCALE:-}" ]; then
  if ! awk -v s="$MENDCODE_TEST_TIME_SCALE" 'BEGIN { exit !(s ~ /^[0-9]+(\.[0-9]+)?$/ && s + 0 >= 1) }'; then
    echo "test-shards: MENDCODE_TEST_TIME_SCALE must be a number of at least 1, got \"$MENDCODE_TEST_TIME_SCALE\"" >&2
    exit 2
  fi
  bun_timeout=$(awk -v s="$MENDCODE_TEST_TIME_SCALE" 'BEGIN { printf "%d", 5000 * s }')
fi
part_seconds="${MENDCODE_TEST_PART_SECONDS:-}"
heartbeat_seconds="${MENDCODE_TEST_HEARTBEAT_SECONDS:-}"
if [ -n "$heartbeat_seconds" ] && ! awk -v s="$heartbeat_seconds" 'BEGIN { exit !(s ~ /^[0-9]+$/ && s + 0 >= 1) }'; then
  echo "test-shards: MENDCODE_TEST_HEARTBEAT_SECONDS must be a whole number of seconds, got \"$heartbeat_seconds\"" >&2
  exit 2
fi
silence_seconds="${MENDCODE_TEST_SILENCE_SECONDS:-}"
if [ -z "$silence_seconds" ]; then
  silence_seconds=$(awk -v s="${MENDCODE_TEST_TIME_SCALE:-1}" 'BEGIN { printf "%d", 300 * s }')
elif ! awk -v s="$silence_seconds" 'BEGIN { exit !(s ~ /^[0-9]+$/) }'; then
  echo "test-shards: MENDCODE_TEST_SILENCE_SECONDS must be a whole number of seconds (0 turns the check off), got \"$silence_seconds\"" >&2
  exit 2
fi
new_session=""
if [ "${MENDCODE_TEST_NEW_SESSION:-}" = 1 ] && command -v setsid >/dev/null 2>&1 && setsid --wait true >/dev/null 2>&1; then new_session="setsid --wait"; fi
selected="$*"
started_all=$(date +%s)
current_part=""
current_log=""
current_started=$started_all
watcher=""
watchdog=""

# The test file a part's output says it is in (bun prints each file's name before its results; GitHub Actions wraps it in a group).
last_file() {
  grep -E '\.test\.ts:?$' "$1" 2>/dev/null | tail -n 1 | sed -e 's/^.*::group:://' -e 's/^.*##\[group\]//' -e 's/:$//'
}

# Load, memory and the biggest process, on one line. Linux reads /proc; elsewhere only what `ps` gives.
snapshot() {
  load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
  mem=""
  if [ -r /proc/meminfo ]; then
    mem=$(awk '/^MemTotal:/ { total = int($2 / 1024) } /^MemAvailable:/ { available = int($2 / 1024) } /^SwapFree:/ { swap = int($2 / 1024) } END { printf "mem_available=%sMB of %sMB swap_free=%sMB", available, total, swap }' /proc/meminfo)
  fi
  top=$(ps -Ao rss=,comm= 2>/dev/null | sort -rn | head -n 1 | awk '{ printf "%dMB %s", $1 / 1024, $2 }')
  printf 'load=%s %s top=[%s]' "${load:-?}" "${mem:-mem=?}" "${top:-?}"
}

# What the kernel logged about killing a process for memory, when this user may read it.
oom_evidence() {
  { dmesg 2>/dev/null || sudo -n dmesg 2>/dev/null; } | grep -i -E 'out of memory|oom-kill|killed process|oom_reaper' | tail -n 5 | sed 's/^/      kernel: /'
}

# One line every `heartbeat_seconds` while a part runs: when the job is cancelled the log ends with the last of them.
start_heartbeat() {
  [ -n "$heartbeat_seconds" ] || return 0
  (
    while sleep "$heartbeat_seconds" >/dev/null 2>&1; do
      printf 'heartbeat %-9s +%4ss %s last=%s\n' "$current_part" "$(( $(date +%s) - current_started ))" "$(snapshot)" "$(last_file "$current_log")"
    done
  ) &
  watcher=$!
}

stop_heartbeat() {
  [ -n "$watcher" ] || return 0
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  watcher=""
}

# The process of the part that is running: the child of this script that is not a copy of it (the heartbeat and the silence check are).
part_pid() {
  ps -Ao pid=,ppid=,args= 2>/dev/null | awk -v me="$$" '
    { pid = $1; parent = $2; $1 = ""; $2 = ""; sub(/^ +/, ""); if (pid == me) self = $0; else if (parent == me) { pids[++n] = pid; args[n] = $0 } }
    END { for (i = 1; i <= n; i++) if (args[i] != self) { print pids[i]; exit } }'
}

# Every process below pid $1.
descendants() {
  ps -Ao pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { parent[$1] = $2 }
    END { for (p in parent) { q = parent[p]; hops = 0; while (q != root && (q in parent) && hops++ < 64) q = parent[q]; if (q == root) print p } }'
}

# A part whose log has not grown for `silence_seconds` is hung: say where, show its processes, kill it. `part` reads the mark and fails the run.
start_watchdog() {
  [ "$silence_seconds" -gt 0 ] || return 0
  (
    tick=5
    [ "$silence_seconds" -lt "$tick" ] && tick=$silence_seconds
    quiet=0
    last=""
    while sleep "$tick" >/dev/null 2>&1; do
      size=$(wc -c < "$current_log" 2>/dev/null | tr -d ' ')
      if [ "$size" != "$last" ]; then last=$size; quiet=0; continue; fi
      quiet=$(( quiet + tick ))
      [ "$quiet" -ge "$silence_seconds" ] || continue
      pid=$(part_pid)
      : > "$current_log.hung"
      printf '%-9s HUNG  no output for %ss, %ss into the part; last test file: %s\n' "$current_part" "$quiet" "$(( $(date +%s) - current_started ))" "$(last_file "$current_log")"
      if [ -z "$pid" ]; then echo "  the process of the part was not found; nothing was killed"; exit 0; fi
      below=$(descendants "$pid" | tr '\n' ' ')
      echo "  the part and every process below it (pid ppid pgid elapsed state command):"
      for one in $pid $below; do ps -o pid=,ppid=,pgid=,etime=,stat=,args= -p "$one" 2>/dev/null; done | cut -c1-240 | sed 's/^/      /'
      if command -v sample >/dev/null 2>&1; then
        echo "  where pid $pid is (sample, 1 s):"
        sample "$pid" 1 2>/dev/null | awk '/^Call graph:/ { on = 1 } /^Total number in stack/ { on = 0 } on' | head -n 80 | cut -c1-200 | sed 's/^/      | /'
      fi
      # shellcheck disable=SC2086
      kill -9 $below "$pid" 2>/dev/null
      exit 0
    done
  ) &
  watchdog=$!
}

stop_watchdog() {
  [ -n "$watchdog" ] || return 0
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  watchdog=""
}

keep_log() {
  [ -n "${MENDCODE_TEST_LOG_DIR:-}" ] && [ -n "$current_log" ] && [ -f "$current_log" ] || return 0
  mkdir -p "$MENDCODE_TEST_LOG_DIR" && cp "$current_log" "$MENDCODE_TEST_LOG_DIR/${current_part:-part}.log"
}

# A signal arrived at this script itself.
on_signal() {
  stop_heartbeat
  stop_watchdog
  printf '\ntest-shards: received SIG%s during part "%s" after %ss (this script is pid %s, parent %s, process group %s)\n' "$1" "${current_part:-none}" "$(( $(date +%s) - current_started ))" "$$" "$PPID" "$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')"
  printf '  last test file: %s\n  %s\n' "$(last_file "$current_log")" "$(snapshot)"
  echo "  biggest processes (pid ppid pgid rss-KiB elapsed command):"
  ps -Ao pid=,ppid=,pgid=,rss=,etime=,comm= 2>/dev/null | sort -k4 -rn | head -n 12 | sed 's/^/      /'
  oom_evidence
  keep_log
  exit $(( 128 + $2 ))
}
trap 'on_signal TERM 15' TERM
trap 'on_signal INT 2' INT
trap 'on_signal HUP 1' HUP

# One line per failed test, taken from bun's own output: the file's group line, the lines since the previous result, then the (fail) line.
# Under GitHub Actions bun repeats the message as an `::error` annotation (`##[error]` once the runner has read it) right before
# (fail); that copy is dropped. At the end bun prints "N tests failed:" and lists every `(fail)` again, without the details and
# after the last file's lines: reading on would file them all under the last file, so the report stops at that line.
failures() {
  awk '
    /^ *[0-9]+ tests? failed:$/ { exit }
    /\.test\.ts:$/ { file = $0; sub(/^.*(##\[group\]|::group::)/, "", file); sub(/:$/, "", file); n = 0; skipping = 0; next }
    /^\((pass|skip|todo)\)/ { n = 0; skipping = 0; next }
    /^(##\[error\]|::error)/ { skipping = 1; next }
    /^(##\[|::group::|::endgroup::|::warning|::notice)/ { next }
    /^\(fail\)/ {
      name = $0; sub(/^\(fail\) /, "", name)
      print "  FAIL " file
      print "    " name
      from = n > 50 ? n - 50 : 0
      for (i = from; i < n; i++) print "      | " buf[i]
      n = 0; skipping = 0; lastfail = 1; next
    }
    lastfail && /^ *\^ this test timed out/ { sub(/^ */, ""); print "      " $0; lastfail = 0; next }
    { lastfail = 0 }
    !skipping && NF { buf[n++] = $0 }
  ' "$1"
}

part() {
  name=$1; shift
  # $part_label names one process of a part that runs as several (cli-1 of cli): its lines and its kept log carry the label.
  label=${part_label:-$name}; part_label=""
  case " $selected " in *" $name "*) ;; *) [ -z "$selected" ] || return 0 ;; esac
  name=$label
  log=$(mktemp)
  if [ -n "$bun_timeout" ]; then set -- --timeout "$bun_timeout" "$@"; fi
  started=$(date +%s)
  current_part=$name current_log=$log current_started=$started
  printf '%-9s start %s\n' "$name" "$(date -u +%H:%M:%S)"
  start_heartbeat
  start_watchdog
  # $new_session is empty or `setsid --wait`; it is meant to split into words.
  # shellcheck disable=SC2086
  if [ -n "$part_seconds" ] && command -v timeout >/dev/null 2>&1; then
    $new_session timeout -k 15 "$part_seconds" bun test "$@" > "$log" 2>&1
  else
    $new_session bun test "$@" > "$log" 2>&1
  fi
  code=$?
  stop_heartbeat
  stop_watchdog
  hung=""
  if [ -f "$log.hung" ]; then hung=1; rm -f "$log.hung"; fi
  seconds=$(( $(date +%s) - started ))
  printf '%-9s %5ss  exit %s  %s\n' "$name" "$seconds" "$code" "$(grep -E '^ *[0-9]+ (pass|fail|skip)|^Ran ' "$log" | tr -s ' ' | tr '\n' ' ')"
  if [ "$code" -ne 0 ]; then
    failed=1
    found=$(failures "$log")
    if [ -n "$found" ]; then printf '%s\n' "$found"; fi
    if [ "$code" -gt 128 ] && [ "$code" -ne 137 ]; then
      echo "  PART ENDED BY SIGNAL $(( code - 128 )) ($(kill -l $(( code - 128 )) 2>/dev/null)) in test file: $(last_file "$log"); $(snapshot)"
      oom_evidence
    fi
    if [ -n "$hung" ]; then
      echo "  PART HUNG: killed after ${silence_seconds}s without output (the report is above); the last output of the part:"
      tail -n 60 "$log" | sed 's/^/      | /'
    elif [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
      [ "$code" -eq 137 ] && oom_evidence
      echo "  PART TIMED OUT after ${part_seconds}s; the last output of the part:"
      tail -n 60 "$log" | sed 's/^/      | /'
    elif [ -z "$found" ]; then
      echo "  PART FAILED (exit $code) without a failing test (crash, no tests found, unhandled error); the last output of the part:"
      tail -n 60 "$log" | sed 's/^/      | /'
    fi
  fi
  keep_log
  rm -f "$log"
  current_log=""
}

# apps/cli runs as one process per CLI_FILES files, in name order. A bun process keeps what every file it ran left behind:
# 25 files hold 0.35 to 1.4 GB, and the 193 files of a-l reached 7.3 GB, which the 8 GB CI runner's OOM killer ended
# (2026-10-28). 40 files stay near 2 GB however the suite grows; a file outside apps/cli/test fails the run.
CLI_FILES=40
cli_listed=$(ls apps/cli/test/*.test.ts 2>/dev/null)
cli_all=$(find apps/cli -name '*.test.ts' -not -path '*/node_modules/*' | wc -l | tr -d ' ')
if [ "$cli_all" -ne "$(printf '%s\n' "$cli_listed" | grep -c .)" ]; then
  echo "test-shards: apps/cli has $cli_all test files but apps/cli/test names $(printf '%s\n' "$cli_listed" | grep -c .); a test outside apps/cli/test would never run" >&2
  exit 2
fi
cli_n=0
cli_group=""
cli_count=0
for file in $cli_listed; do
  cli_group="$cli_group $file"
  cli_count=$((cli_count + 1))
  if [ "$cli_count" -eq "$CLI_FILES" ]; then
    cli_n=$((cli_n + 1))
    # shellcheck disable=SC2086
    part_label=cli-$cli_n part cli $cli_group
    cli_group=""
    cli_count=0
  fi
done
if [ -n "$cli_group" ]; then
  cli_n=$((cli_n + 1))
  # shellcheck disable=SC2086
  part_label=cli-$cli_n part cli $cli_group
fi
part daemon packages/daemon
# shellcheck disable=SC2086
part packages $others
# shellcheck disable=SC2086
part rest scripts/ examples/ $apps
printf 'total     %5ss  %s\n' "$(( $(date +%s) - started_all ))" "$([ "$failed" -eq 0 ] && echo passed || echo FAILED)"
exit $failed
