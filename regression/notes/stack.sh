#!/usr/bin/env bash
# Local stack of the notes service: app/server.ts in-memory, no dependencies.
#   stack.sh up | down | status | reset
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# vgate names the stack library (VGATE_STACK_LIB); run by hand in the framework's checkout, it is next door.
# shellcheck source=../../framework/stack/lib.sh
source "${VGATE_STACK_LIB:-$HERE/../../framework/stack/lib.sh}"
stack_init notes

PORT="${EXAMPLE_PORT:-8090}"
HEALTH="http://localhost:$PORT/health"
BUILD_REPO="$STACK_ROOT" # the service's code lives in this repo

up() {
  if http_ok "$HEALTH"; then echo "notes already UP at $HEALTH"; return; fi
  app_start "$STACK_ROOT" env EXAMPLE_PORT="$PORT" "$STACK_RUNTIME/node_modules/.bin/tsx" "$HERE/../../app/server.ts"
  app_wait "$HEALTH" 30
}

down() { app_stop; }

status() { app_status "$HEALTH" "$STACK_ROOT"; }

# The data lives in memory: a restart is the reset.
reset() {
  app_stop
  up
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  reset) reset ;;
  *) echo "Usage: $0 up|down|status|reset" >&2; exit 2 ;;
esac
