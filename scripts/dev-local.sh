#!/usr/bin/env bash
#
# dev-local.sh — bring ScholarAssist's local dev stack up in one command.
#
# This repo is a CLI; there is exactly one long-lived thing worth serving: a
# static server over the repo root, giving http:// URLs for the generated
# config-browser site and the e2e fixture form (handy for headed manual runs).
#
# Usage:
#   scripts/dev-local.sh up            # build site + start the static server (idempotent)
#   scripts/dev-local.sh down          # stop everything
#   scripts/dev-local.sh status        # window list + port check
#   scripts/dev-local.sh logs site     # tail the server window
#   scripts/dev-local.sh restart site  # rebuild site/ and restart the server
#   scripts/dev-local.sh attach        # attach to the tmux session (Ctrl-b d to detach)
#   scripts/dev-local.sh setup         # first run: pnpm install + Playwright chromium
#
set -euo pipefail

SESSION="scholar-dev"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_PORT=8410

# Long-lived servers: "window_name|start command".
SERVERS=(
  "site|node scripts/build-site.mjs && exec python3 -m http.server $SITE_PORT -b 127.0.0.1 -d '$ROOT'"
)

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_red=$'\033[31m'; c_cyn=$'\033[36m'
say()  { printf "%s\n" "$*"; }
info() { printf "${c_cyn}▸ %s${c_reset}\n" "$*"; }
ok()   { printf "${c_grn}✓ %s${c_reset}\n" "$*"; }
warn() { printf "${c_ylw}! %s${c_reset}\n" "$*"; }
die()  { printf "${c_red}✗ %s${c_reset}\n" "$*" >&2; exit 1; }
port_up() { lsof -ti :"$1" -sTCP:LISTEN >/dev/null 2>&1; }

preflight() {
  command -v tmux    >/dev/null 2>&1 || die "tmux not found. Install: pacman -S tmux"
  command -v pnpm    >/dev/null 2>&1 || die "pnpm not found."
  command -v python3 >/dev/null 2>&1 || die "python3 not found (serves site/)."
  [ -d "$ROOT/node_modules" ] || die "Deps not installed. Run: scripts/dev-local.sh setup"
}

start_window() {  # idempotent: skip if the window already exists
  local name="$1" cmd="$2"
  if tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$name"; then
    warn "window '$name' already exists — leaving it alone"; return
  fi
  tmux new-window -t "$SESSION" -n "$name" -c "$ROOT"
  tmux send-keys -t "$SESSION:$name" "$cmd" C-m
}

port_check() {
  say "  Port status (${c_dim}· = still starting${c_reset}):"
  if port_up "$SITE_PORT"; then printf "    ${c_grn}●${c_reset} %-6s :%s\n" "site" "$SITE_PORT"
  else                          printf "    ${c_dim}·${c_reset} %-6s :%s\n" "site" "$SITE_PORT"; fi
}

cmd_up() {
  preflight
  tmux has-session -t "$SESSION" 2>/dev/null || tmux new-session -d -s "$SESSION" -n _bootstrap -c "$ROOT"
  for s in "${SERVERS[@]}"; do start_window "${s%%|*}" "${s#*|}"; done
  tmux kill-window -t "$SESSION:_bootstrap" 2>/dev/null || true
  echo; ok "Stack starting in tmux session '$SESSION'."; echo
  port_check
  echo
  say "  Config browser:  ${c_cyn}http://127.0.0.1:$SITE_PORT/site/${c_reset}"
  say "  Fixture form:    ${c_cyn}http://127.0.0.1:$SITE_PORT/test/fixtures/testsite/form.html${c_reset}"
  echo
  say "${c_dim}  Logs:   scripts/dev-local.sh logs site${c_reset}"
  say "${c_dim}  Attach: scripts/dev-local.sh attach   (Ctrl-b d to detach)${c_reset}"
  say "${c_dim}  Stop:   scripts/dev-local.sh down${c_reset}"
}

cmd_status() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    info "tmux '$SESSION' windows:"
    tmux list-windows -t "$SESSION" -F '    #{window_index}: #{window_name}'
  else warn "session '$SESSION' not running"; fi
  echo; port_check
}

cmd_setup() {
  command -v pnpm >/dev/null 2>&1 || die "pnpm not found."
  ( cd "$ROOT" && pnpm install && pnpm exec playwright install chromium )
  ok "setup done — now: scripts/dev-local.sh up"
}

cmd_logs()    { tmux has-session -t "$SESSION" 2>/dev/null || die "session not running"; tmux capture-pane -p -S -400 -t "$SESSION:${1:?usage: logs <name>}"; }
cmd_restart() { tmux has-session -t "$SESSION" 2>/dev/null || die "session not running"
  local n="${1:?usage: restart <name>}"; tmux kill-window -t "$SESSION:$n" 2>/dev/null || true
  for s in "${SERVERS[@]}"; do [ "${s%%|*}" = "$n" ] && start_window "$n" "${s#*|}" && { ok "restarted $n"; return; }; done
  die "unknown window '$n'"; }
cmd_attach()  { tmux has-session -t "$SESSION" 2>/dev/null || die "not running — start with: dev-local.sh up"; tmux attach -t "$SESSION"; }
cmd_down()    { tmux kill-session -t "$SESSION" 2>/dev/null && ok "dev stack stopped" || warn "no session '$SESSION'"; }

case "${1:-up}" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${2:-}" ;;
  restart) cmd_restart "${2:-}" ;;
  attach)  cmd_attach ;;
  setup)   cmd_setup ;;
  -h|--help|help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next}{exit}' "${BASH_SOURCE[0]}" ;;
  *) die "unknown command '$1' (try: up|down|status|logs|restart|attach|setup)" ;;
esac
