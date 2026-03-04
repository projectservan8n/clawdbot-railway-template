#!/usr/bin/env bash
set -e

# Start Tailscale if auth key is provided
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  echo "Starting Tailscale..."
  tailscaled --tun=userspace-networking &
  sleep 3
  tailscale up --authkey="$TAILSCALE_AUTHKEY" --hostname="openclaw-railway" --accept-routes
  echo "Tailscale up!"
  tailscale funnel --bg 18789
  echo "Tailscale Funnel active - port 18789 exposed"
fi

# Start OpenClaw
exec node src/server.js
