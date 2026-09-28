#!/bin/zsh
# usage: run.sh <scenario.mjs> [args...]
set -u
SCEN="$1"; shift
WEB=/Users/wuyongping/.codex/worktrees/8f78/knowledge-indexer/web
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
rm -rf /tmp/ki-e2e/profile; mkdir -p /tmp/ki-e2e/profile
(cd "$WEB" && npx vite --port 5188 --host 127.0.0.1 > /tmp/ki-e2e/vite.log 2>&1) &
VITE_PID=$!
"$CHROME" --headless=new --disable-gpu --remote-debugging-port=9334 --user-data-dir=/tmp/ki-e2e/profile --no-first-run about:blank > /tmp/ki-e2e/chrome.log 2>&1 &
CHROME_PID=$!
cleanup() {
  kill -9 $VITE_PID $CHROME_PID 2>/dev/null
  lsof -ti tcp:5188 2>/dev/null | xargs kill -9 2>/dev/null
  lsof -ti tcp:9334 2>/dev/null | xargs kill -9 2>/dev/null
  pkill -9 -f "remote-debugging-por[t]=9334" 2>/dev/null
  return 0
}
trap cleanup EXIT
for i in {1..80}; do
  V=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:5188/browse)
  C=$(curl -s --max-time 2 http://127.0.0.1:9334/json/version | head -c 1)
  [ "$V" = "200" ] && [ "$C" = "{" ] && break
  sleep 0.5
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:5188/browse)" != "200" ]; then echo "vite failed to start"; tail -20 /tmp/ki-e2e/vite.log; exit 9; fi
node "/tmp/ki-e2e/$SCEN" "$@"
