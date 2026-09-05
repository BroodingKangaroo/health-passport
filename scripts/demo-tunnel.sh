#!/usr/bin/env bash
# Fast demo hosting via a public tunnel (no signup, no cloud account).
#
# Usage:
#   scripts/demo-tunnel.sh              # start backend + frontend + tunnel, print public URL
#   scripts/demo-tunnel.sh --rebuild    # force a fresh frontend production build first
#   scripts/demo-tunnel.sh --stop       # tear everything down
#
# What it does:
#   1. Reuses the backend on :8000 if one is already listening, else starts
#      uvicorn from backend/ (loads backend/.env — requires MISTRAL_API_KEY).
#   2. Builds the frontend if no production build exists (unless --rebuild),
#      then serves it on :3000 with NEXTAUTH_URL pointed at the tunnel URL —
#      the URL is random per run, so the frontend is always (re)started AFTER
#      the tunnel is up. Any stale server on :3000 is killed first.
#   3. Opens a free pinggy tunnel (ssh -p 443 -R0 to free.pinggy.io — works
#      on networks where Cloudflare quick tunnels are blocked, verified) and
#      extracts the https URL from its output.
#   4. Verifies the login page and the backend API through the public URL.
#
# Notes:
#   - The free tunnel URL expires after 60 minutes; re-run this script for a
#     fresh URL. Users must re-login on the new domain (cookies are per-domain).
#   - caffeinate keeps the Mac awake for the whole demo.
#   - The demo uses your real local dev DB (backend/health_passport.db).

set -euo pipefail
# Monitor mode: background daemons get their own process groups, so a caller
# waiting on this script's process group isn't held by them after exit.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/hp-demo"
mkdir -p "$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

port_pid() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
wait_for() { # wait_for <curl-url> <tries>
  for _ in $(seq 1 "$2"); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$1" || true)" = "200" ] && return 0
    sleep 1
  done
  return 1
}

stop_all() {
  local pids
  for port in 3000 8000; do
    pids="$(port_pid "$port")"
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
  done
  pkill -f "ssh.*free\.pinggy\.io" 2>/dev/null || true
  pkill -x caffeinate 2>/dev/null || true
  echo "Stopped."
}

[ "${1:-}" = "--stop" ] && stop_all && exit 0

# --- backend ---------------------------------------------------------------
BACKEND_ENV="$ROOT/backend/.env"
[ -f "$BACKEND_ENV" ] || { echo "ERROR: $BACKEND_ENV not found (needs MISTRAL_API_KEY)"; exit 1; }
grep -q "^MISTRAL_API_KEY=." "$BACKEND_ENV" || { echo "ERROR: MISTRAL_API_KEY missing in backend/.env"; exit 1; }

if [ -n "$(port_pid 8000)" ]; then
  echo "Backend already running on :8000 — reusing it."
else
  (cd "$ROOT/backend" && nohup venv/bin/uvicorn app.main:app --port 8000 </dev/null > "$BACKEND_LOG" 2>&1 &)
  wait_for "http://localhost:8000/api/biomarkers/definitions" 20 \
    || { echo "ERROR: backend did not come up — see $BACKEND_LOG"; exit 1; }
  echo "Backend started on :8000."
fi

# --- tunnel (before frontend: NEXTAUTH_URL needs the URL) -------------------
pkill -f "ssh.*free\.pinggy\.io" 2>/dev/null || true
sleep 1
nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -p 443 \
  -R0:localhost:3000 free.pinggy.io </dev/null > "$TUNNEL_LOG" 2>&1 &
TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL="$(grep -oE 'https://[a-zA-Z0-9-]+\.(free\.pinggy\.net|run\.pinggy-free\.link)' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
[ -n "$TUNNEL_URL" ] || { echo "ERROR: tunnel URL not allocated — see $TUNNEL_LOG"; exit 1; }
echo "Tunnel up: $TUNNEL_URL (free tier: expires in 60 minutes)"

# --- frontend ---------------------------------------------------------------
if [ ! -f "$ROOT/frontend/.next/BUILD_ID" ] || [ "${1:-}" = "--rebuild" ]; then
  echo "Building frontend (production)…"
  (cd "$ROOT/frontend" && pnpm build) || { echo "ERROR: frontend build failed"; exit 1; }
fi

pids="$(port_pid 3000)"
[ -n "$pids" ] && kill $pids 2>/dev/null || true
(cd "$ROOT/frontend" && NEXTAUTH_URL="$TUNNEL_URL" nohup pnpm start </dev/null > "$FRONTEND_LOG" 2>&1 &)

wait_for "http://localhost:3000/login" 30 \
  || { echo "ERROR: frontend did not come up — see $FRONTEND_LOG"; exit 1; }

# --- verify through the public URL ------------------------------------------
wait_for "$TUNNEL_URL/login" 15 \
  || { echo "ERROR: public URL not reachable — see $TUNNEL_LOG"; exit 1; }
curl -s -o /dev/null -m 15 "$TUNNEL_URL/api/biomarkers/definitions" \
  || { echo "ERROR: backend not reachable through the tunnel"; exit 1; }

pgrep -x caffeinate > /dev/null || { nohup caffeinate -dims </dev/null > /dev/null 2>&1 & }
disown -a 2>/dev/null || true

echo ""
echo "=========================================================="
echo "  Demo live:  $TUNNEL_URL"
echo "  Logs:       $LOG_DIR"
echo "  Tear down:  scripts/demo-tunnel.sh --stop"
echo "  The URL dies in ~60 min (or on --stop). Re-running this"
echo "  script issues a fresh URL; users must re-login."
echo "=========================================================="
