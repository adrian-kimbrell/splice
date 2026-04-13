#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=19990
BASE="http://localhost:$PORT"
ZDOTDIR="/tmp/splice-demo/zsh-home"
NO_RESTART="${1:-}"
PORT_FILE="/tmp/splice-dev-api.port"

api() {
  local method=$1 path=$2 data="${3:-}"
  if [ -n "$data" ]; then
    curl -sf -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$data"
  else
    curl -sf "$BASE$path"
  fi
}

wait_ready() {
  echo -n "Waiting for dev server"
  for i in $(seq 1 120); do
    if [ -f "$PORT_FILE" ]; then
      local p; p=$(cat "$PORT_FILE")
      if [ "$(curl -s "http://localhost:$p/dev/ping" 2>/dev/null)" = '{"ok":true}' ]; then
        PORT=$p; BASE="http://localhost:$PORT"
        echo -n " ready on :$PORT (${i}s) — waiting for frontend"
        for j in $(seq 1 10); do sleep 1; echo -n "."; done
        echo ""
        return 0
      fi
    fi
    echo -n "."; sleep 1
  done
  echo " TIMEOUT"; exit 1
}

if [ "$NO_RESTART" != "--no-restart" ]; then
  pkill -9 splice 2>/dev/null || true
  pkill -9 -f "vite|tauri dev" 2>/dev/null || true
  sleep 1
  rm -f "$PORT_FILE"
  npm run tauri dev > /tmp/splice-dev.log 2>&1 &
  wait_ready
else
  wait_ready
fi

# Reset state
api POST /dev/reset '{}' > /dev/null
api POST /dev/set-zdotdir "{\"dir\":\"$ZDOTDIR\"}" > /dev/null
api POST /dev/resize '{"width":1680,"height":1050}' > /dev/null
sleep 0.5

# Open the api project — 2.5s for file tree to load
api POST /dev/open-folder '{"path":"/tmp/splice-demo/api"}' > /dev/null
sleep 2.5

# Open files
api POST /dev/open-file '{"path":"/tmp/splice-demo/api/src/handlers/auth.rs"}' > /dev/null; sleep 0.3
api POST /dev/open-file '{"path":"/tmp/splice-demo/api/src/models.rs"}' > /dev/null; sleep 0.3
api POST /dev/open-file '{"path":"/tmp/splice-demo/api/src/db.rs"}' > /dev/null; sleep 0.3
api POST /dev/open-file '{"path":"/tmp/splice-demo/api/src/handlers/auth.rs"}' > /dev/null; sleep 0.3

# Run a command in terminal 1 — use full path since terminal starts in HOME
api POST /dev/run-terminal '{"cmd":"ls -la --color=always /tmp/splice-demo/api/src/\r"}' > /dev/null
sleep 2.5

# Split terminal vertically (two terminals stacked)
api POST /dev/split-pane '{"direction":"vertical"}' > /dev/null
sleep 3.0

# Run something in terminal 2
api POST /dev/run-terminal '{"cmd":"ls --color=always /tmp/splice-demo/api/src/handlers/\r"}' > /dev/null
sleep 2.5

# Hide sidebar panels
api POST /dev/ui '{"workspacesVisible":false,"explorerVisible":false}' > /dev/null
sleep 1.0

# Take the shot
echo -n "Taking screenshot ... "
result=$(api POST /dev/screenshot '{"name":"hero"}')
echo "$result" | grep -o '"path":"[^"]*"' | cut -d'"' -f4

ls -lh docs/screenshots/screenshot-hero.png 2>/dev/null | awk '{print $5, $9}'
