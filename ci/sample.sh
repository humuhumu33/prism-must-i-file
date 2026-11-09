#!/bin/sh
# Every 2 s, write "<unix seconds> <process name>" for each running process.
# Measurement only (measure branch).
out=$1
while :; do
  t=$(date +%s)
  for p in /proc/[0-9]*; do
    c=$(cat "$p/comm" 2>/dev/null) && echo "$t $c"
  done
  sleep 2
done >"$out"
