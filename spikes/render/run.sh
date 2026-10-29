#!/bin/bash
# Runs each render variant 60 s in tmux 160x45 and records CPU/footprint. Output: RESULT.raw
cd "$(dirname "$0")"
fp() { vmmap --summary "$1" 2>/dev/null | awk '/Physical footprint:/ {print $3}'; }
: > RESULT.raw
for v in opentui-naive opentui-window diff-renderer; do
  tmux new-session -d -s "spk_$v" -x 160 -y 45 "bun $v.ts"
  t0=$(date +%s)
  first=""
  while [ -z "$first" ]; do
    [ -n "$(tmux capture-pane -p -t spk_$v | tr -d ' \n')" ] && first=$(( $(date +%s) - t0 ))
    sleep 0.1
  done
  pid=$(pgrep -f "^bun $v.ts" | head -1)
  sleep 5; fp5=$(fp $pid)
  sleep 20
  total=0; n=0
  for i in $(seq 1 30); do c=$(ps -o %cpu= -p $pid | tr -d ' '); total=$(echo "$total + ${c:-0}" | bc); n=$((n+1)); sleep 1; done
  fp55=$(fp $pid)
  tmux capture-pane -p -t spk_$v | tail -3 > "pane-$v.txt"
  echo "$v first_frame_s=$first footprint_5s=$fp5 footprint_55s=$fp55 cpu_avg_25_55s=$(echo "scale=1; $total / $n" | bc)" | tee -a RESULT.raw
  tmux kill-session -t "spk_$v" 2>/dev/null; sleep 2
done
