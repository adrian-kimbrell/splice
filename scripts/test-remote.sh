#!/bin/sh
# Run Splice's test suite on the test machine instead of this Mac.
#
#   scripts/test-remote.sh            # everything CI runs: unit, rust, e2e
#   scripts/test-remote.sh unit       # vitest + svelte-check
#   scripts/test-remote.sh rust       # cargo clippy + cargo test
#   scripts/test-remote.sh e2e        # build the E2E binary, run WebdriverIO
#   scripts/test-remote.sh unit rust  # any combination
#
# The working tree (committed or not) is copied with rsync, so what is tested is
# exactly what is on disk here. Build caches (node_modules, target) stay on the
# test machine between runs.
#
# Requirements on the test machine: SSH key access, Node, Rust (rustup), Xcode
# Command Line Tools, and for `e2e` a user logged in at the console, because the
# app opens real windows.
#
#   SPLICE_TEST_HOST   host to use (default takeshi.local)
#   SPLICE_TEST_DIR    directory there (default splice-test, relative to $HOME)
set -eu

HOST="${SPLICE_TEST_HOST:-takeshi.local}"
DIR="${SPLICE_TEST_DIR:-splice-test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STEPS="${*:-unit rust e2e}"

for step in $STEPS; do
  case "$step" in
    unit|rust|e2e) ;;
    *) echo "unknown step: $step (use unit, rust, e2e)" >&2; exit 2 ;;
  esac
done

echo "==> syncing $ROOT to $HOST:$DIR"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude dist \
  --exclude 'src-tauri/target' --exclude 'src-tauri/gen' \
  --exclude '.DS_Store' \
  "$ROOT/" "$HOST:$DIR/"

# One remote shell: login profile for Homebrew's PATH, cargo env for Rust.
# caffeinate keeps the machine and display awake for the length of the run.
ssh -o BatchMode=yes "$HOST" "STEPS='$STEPS' DIR='$DIR' caffeinate -dims zsh -l -s" <<'REMOTE'
set -e
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
cd "$HOME/$DIR"
started=$(date +%s)

# Reinstall dependencies only when the lockfile changed.
lock_sum=$(shasum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat node_modules/.lock-sum 2>/dev/null)" != "$lock_sum" ]; then
  echo "==> npm ci"
  npm ci --no-audit --no-fund
  echo "$lock_sum" > node_modules/.lock-sum
fi

for step in ${=STEPS}; do
  case "$step" in
    unit)
      echo "==> unit: vitest"
      npm test
      echo "==> unit: svelte-check"
      npx svelte-check --threshold error
      ;;
    rust)
      echo "==> rust: clippy"
      (cd src-tauri && cargo clippy --all-targets -- -D warnings)
      echo "==> rust: cargo test"
      (cd src-tauri && cargo test)
      ;;
    e2e)
      if [ "$(stat -f %Su /dev/console)" != "$(whoami)" ]; then
        echo "e2e needs $(whoami) logged in at the console of $(hostname)" >&2
        exit 1
      fi
      echo "==> e2e: build"
      npm run build:e2e
      echo "==> e2e: run"
      npm run test:e2e
      ;;
  esac
done
echo "==> all steps passed on $(hostname) in $(( $(date +%s) - started ))s"
REMOTE
