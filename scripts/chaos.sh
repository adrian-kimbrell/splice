#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Splice Chaos & Smoke Test
#
# Usage:
#   ./scripts/chaos.sh [workspace-dir] [duration-seconds]
#
# What it does:
#   1. Finds the running Splice process (or tells you to start it first).
#   2. Creates a temporary workspace directory, or uses the one you provide.
#   3. Tells you to open that directory as a workspace in Splice, then waits.
#   4. Runs five chaos phases in a loop:
#        Phase A – rapid file creation
#        Phase B – concurrent file modifications
#        Phase C – create / delete subdirectory trees
#        Phase D – rename cascade (simulates "save" patterns)
#        Phase E – brief quiet period (lets debounce timers settle)
#   5. All the while, samples the Splice process every 2 s for:
#        – RSS memory (KB)
#        – CPU %
#        – Open file-descriptor count (proxy for watcher leaks)
#   6. Prints a summary with min/max/average for each metric.
#   7. Fails with exit code 1 if Splice died, or RSS grew by >100 MB.
#
# Requirements: bash 3+, macOS (uses `lsof` and `ps -o`).
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

# ── Args / flags ─────────────────────────────────────────────────────────────
NO_WAIT=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --no-wait) NO_WAIT=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

# ── Config ───────────────────────────────────────────────────────────────────
WORKSPACE="${POSITIONAL[0]:-}"
DURATION="${POSITIONAL[1]:-60}"         # seconds to run chaos loop
SAMPLE_INTERVAL=2           # seconds between perf samples
RSS_LEAK_THRESHOLD=102400   # KB  (100 MB growth triggers failure)
LOG_DIR="$(pwd)/chaos-logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/run-$TIMESTAMP.log"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET} $*"; }
ok()      { echo -e "${GREEN}[ OK ]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET} $*"; }
fail()    { echo -e "${RED}[FAIL]${RESET} $*"; }
section() { echo -e "\n${BOLD}═══ $* ═══${RESET}"; }

# ── Setup ────────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
# Single tee at the process level — no per-function pipe needed, avoids SIGPIPE
exec > >(tee -a "$LOG_FILE") 2>&1
echo "Splice Chaos Test — $TIMESTAMP"
echo "Duration: ${DURATION}s  Sample interval: ${SAMPLE_INTERVAL}s"
echo ""

section "1. Locating Splice process"

SPLICE_PID=""
for name in splice Splice; do
  SPLICE_PID=$(pgrep -x "$name" 2>/dev/null | head -1 || true)
  [ -n "$SPLICE_PID" ] && break
done

if [ -z "$SPLICE_PID" ]; then
  warn "Splice is not running."
  warn "Start it with:  cargo tauri dev  (or open the built app)"
  warn "Then re-run this script."
  exit 1
fi

ok "Found Splice (PID $SPLICE_PID)"
echo "splice_pid=$SPLICE_PID" >> "$LOG_FILE"

# ── Workspace dir ────────────────────────────────────────────────────────────
section "2. Workspace directory"

if [ -z "$WORKSPACE" ]; then
  WORKSPACE="$(mktemp -d /tmp/splice-chaos-XXXXXX)"
  info "Created temp workspace: $WORKSPACE"
else
  mkdir -p "$WORKSPACE"
  info "Using workspace: $WORKSPACE"
fi

echo "workspace=$WORKSPACE" >> "$LOG_FILE"

echo ""
if [ "$NO_WAIT" = true ]; then
  info "  --no-wait: assuming Splice is already watching a parent of $WORKSPACE"
else
  echo -e "${BOLD}ACTION REQUIRED:${RESET}"
  echo -e "  Open this directory as a workspace in Splice:"
  echo -e "  ${CYAN}$WORKSPACE${RESET}"
  echo ""
  echo -e "  (File → Open Folder, or drag it onto the sidebar)"
  echo ""
  read -rp "  Press Enter when the workspace is open in Splice…" _
fi

# ── Perf monitor (background) ────────────────────────────────────────────────
section "3. Starting performance monitor"

RSS_LOG="$LOG_DIR/rss-$TIMESTAMP.tsv"
echo -e "time\trss_kb\tcpu_pct\tfd_count" > "$RSS_LOG"

monitor_proc() {
  while true; do
    if ! kill -0 "$SPLICE_PID" 2>/dev/null; then
      echo "$(date +%H:%M:%S) PROCESS DIED" >> "$RSS_LOG"
      break
    fi
    RSS=$(ps -o rss= -p "$SPLICE_PID" 2>/dev/null | tr -d ' ' || echo 0)
    CPU=$(ps -o %cpu= -p "$SPLICE_PID" 2>/dev/null | tr -d ' ' || echo 0)
    FDS=$(lsof -p "$SPLICE_PID" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
    TS=$(date +%H:%M:%S)
    echo -e "$TS\t$RSS\t$CPU\t$FDS" >> "$RSS_LOG"
    printf "  %s  RSS=%s KB  CPU=%s%%  FDs=%s\n" "$TS" "$RSS" "$CPU" "$FDS"
    sleep "$SAMPLE_INTERVAL"
  done
}

monitor_proc &
MONITOR_PID=$!
trap 'kill $MONITOR_PID 2>/dev/null || true' EXIT

RSS_START=$(ps -o rss= -p "$SPLICE_PID" 2>/dev/null | tr -d ' ' || echo 0)
FD_START=$(lsof -p "$SPLICE_PID" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
info "Baseline — RSS: ${RSS_START} KB  FDs: ${FD_START}"
echo "rss_start=$RSS_START fd_start=$FD_START" >> "$LOG_FILE"

# ── Chaos loop ───────────────────────────────────────────────────────────────
section "4. Running chaos (${DURATION}s)"

FILE_COUNT=0
ITER=0
START_TS=$(date +%s)

while [ $(( $(date +%s) - START_TS )) -lt "$DURATION" ]; do
  ELAPSED=$(( $(date +%s) - START_TS ))
  ITER=$(( ITER + 1 ))

  # ── Phase A: rapid file creation ─────────────────────────────────────────
  for i in $(seq 1 10); do
    echo "chaos-$RANDOM-$ITER-$i" > "$WORKSPACE/file-$RANDOM.txt"
    FILE_COUNT=$(( FILE_COUNT + 1 ))
  done

  # ── Phase B: concurrent modifications ────────────────────────────────────
  n=0; while IFS= read -r f && [ $n -lt 5 ]; do
    echo "modified-$RANDOM" >> "$f"; n=$((n+1))
  done < <(find "$WORKSPACE" -maxdepth 1 -name "*.txt" 2>/dev/null)

  # ── Phase C: subdirectory trees ──────────────────────────────────────────
  SUBDIR="$WORKSPACE/subdir-$RANDOM"
  mkdir -p "$SUBDIR/nested"
  echo "nested-file" > "$SUBDIR/nested/data.txt"
  # Delete an old subdir (first one found)
  OLD_SUBDIR=$(find "$WORKSPACE" -maxdepth 1 -type d -name "subdir-*" 2>/dev/null | head -1 || true)
  [ -n "$OLD_SUBDIR" ] && rm -rf "$OLD_SUBDIR"

  # ── Phase D: rename cascade (simulates atomic save) ──────────────────────
  n=0; for f in $(find "$WORKSPACE" -maxdepth 1 -name "*.txt" 2>/dev/null); do
    [ $n -ge 3 ] && break; n=$((n+1))
    TMP="${f}.splicetmp"
    cp "$f" "$TMP" && mv "$TMP" "$f"
  done

  # ── Phase E: quiet period every 5 iterations (let debounce settle) ───────
  if [ $(( ITER % 5 )) -eq 0 ]; then
    info "  iter $ITER  elapsed ${ELAPSED}s  files_created=$FILE_COUNT — quiet pause…"
    sleep 0.5
  else
    sleep 0.1
  fi

  # Abort if Splice died
  if ! kill -0 "$SPLICE_PID" 2>/dev/null; then
    fail "Splice process died at iteration $ITER (${ELAPSED}s elapsed)!"
    echo "splice_died=true" >> "$LOG_FILE"
    break
  fi
done

# ── Cleanup workspace ─────────────────────────────────────────────────────────
rm -rf "$WORKSPACE"

# ── Final snapshot ────────────────────────────────────────────────────────────
sleep $(( SAMPLE_INTERVAL + 1 ))  # let monitor grab one more sample
kill "$MONITOR_PID" 2>/dev/null || true
trap - EXIT

# ── Report ────────────────────────────────────────────────────────────────────
section "5. Results"

RSS_END=$(ps -o rss= -p "$SPLICE_PID" 2>/dev/null | tr -d ' ' || echo 0)
FD_END=$(lsof -p "$SPLICE_PID" 2>/dev/null | wc -l | tr -d ' ' || echo 0)

echo "rss_end=$RSS_END fd_end=$FD_END files_created=$FILE_COUNT" >> "$LOG_FILE"

RSS_DELTA=$(( RSS_END - RSS_START ))
FD_DELTA=$(( FD_END - FD_START ))

# Compute min/max/avg RSS from log
if [ -f "$RSS_LOG" ]; then
  eval "$(awk -F'\t' 'NR>1 && $2~/^[0-9]+$/ {
    sum+=$2; count++;
    if(min==""||$2<min) min=$2;
    if($2>max) max=$2
  } END {
    printf "RSS_MIN=%s RSS_MAX=%s RSS_AVG=%d\n", (min==""?"N/A":min), (max==""?"N/A":max), (count>0?sum/count:0)
  }' "$RSS_LOG")"
fi

echo ""
echo -e "  Files created/modified : ${FILE_COUNT}"
echo -e "  Chaos iterations       : ${ITER}"
echo ""
echo -e "  ${BOLD}Memory (RSS)${RESET}"
echo -e "    Start  : ${RSS_START} KB"
echo -e "    End    : ${RSS_END} KB"
echo -e "    Delta  : ${RSS_DELTA} KB"
echo -e "    Min    : ${RSS_MIN:-N/A} KB"
echo -e "    Max    : ${RSS_MAX:-N/A} KB"
echo -e "    Avg    : ${RSS_AVG:-N/A} KB"
echo ""
echo -e "  ${BOLD}File descriptors${RESET}"
echo -e "    Start  : ${FD_START}"
echo -e "    End    : ${FD_END}"
echo -e "    Delta  : ${FD_DELTA}  (watcher leak proxy — should be ~0)"
echo ""
echo -e "  Full perf log : $RSS_LOG"

# ── Pass / Fail ───────────────────────────────────────────────────────────────
FAILED=0

if ! kill -0 "$SPLICE_PID" 2>/dev/null; then
  fail "Splice is no longer running (crashed)."
  FAILED=1
else
  ok "Splice survived the full chaos run."
fi

if [ "$RSS_DELTA" -gt "$RSS_LEAK_THRESHOLD" ]; then
  fail "Memory grew by ${RSS_DELTA} KB (threshold: ${RSS_LEAK_THRESHOLD} KB) — possible leak."
  FAILED=1
else
  ok "Memory growth within threshold (${RSS_DELTA} KB)."
fi

if [ "$FD_DELTA" -gt 20 ]; then
  warn "File descriptor count grew by ${FD_DELTA} — check for watcher accumulation."
else
  ok "File descriptor count stable (delta: ${FD_DELTA})."
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}PASS${RESET} — All checks passed."
else
  echo -e "${RED}${BOLD}FAIL${RESET} — One or more checks failed. See $LOG_FILE"
fi

exit "$FAILED"
