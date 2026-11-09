#!/bin/sh
# Every 2 s, write "<unix seconds> <process name>" for each running process,
# and "<unix seconds> rustc:<crate>" for each rustc, from its --crate-name.
# Measurement only (measure branch).
out=$1
while :; do
  t=$(date +%s)
  for p in /proc/[0-9]*; do
    c=$(cat "$p/comm" 2>/dev/null) || continue
    echo "$t $c"
    if [ "$c" = rustc ]; then
      crate=$(tr '\0' '\n' <"$p/cmdline" 2>/dev/null | grep -A1 -x -- --crate-name | tail -1)
      [ -n "$crate" ] && echo "$t rustc:$crate"
    fi
  done
  sleep 2
done >"$out"
