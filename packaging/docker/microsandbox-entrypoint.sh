#!/usr/bin/env sh
set -eu

MARS_WORKSPACE="${MARS_WORKSPACE:-/workspace}"
MARS_DATA_DIR="${MARS_DATA_DIR:-/data/mars-server}"
MARS_SIDECAR_DIR="${MARS_SIDECAR_DIR:-/data/sidecars}"
MARS_PORT="${MARS_PORT:-8787}"
MARS_TOKEN="${MARS_TOKEN:-microsandbox-token}"
MARS_HOST_TOKEN="${MARS_HOST_TOKEN:-microsandbox-host-token}"
MARS_APPROVAL_MODE="${MARS_APPROVAL_MODE:-auto}"
MARS_CORS_ORIGINS="${MARS_CORS_ORIGINS:-*}"
MARS_CONNECT_HOST="${MARS_CONNECT_HOST:-127.0.0.1}"
MARS_EXTENSIONS_PLUGIN_DIR="${MARS_EXTENSIONS_PLUGIN_DIR:-/opt/mars/opencode-plugins}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
export MARS_DATA_DIR MARS_TOKEN MARS_HOST_TOKEN MARS_EXTENSIONS_PLUGIN_DIR
export MARS_MANAGE_OPENCODE=1
export MARS_OPENCODE_BIN=/usr/local/bin/opencode

mkdir -p "$MARS_WORKSPACE" "$MARS_DATA_DIR" "$MARS_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting MarsAI micro-sandbox"
printf '%s\n' "- workspace: $MARS_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- mars url: http://$MARS_CONNECT_HOST:$MARS_PORT"
printf '%s\n' "- client token: $MARS_TOKEN"
printf '%s\n' "- host token: $MARS_HOST_TOKEN"
printf '%s\n' "- health: curl http://$MARS_CONNECT_HOST:$MARS_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $MARS_TOKEN\" http://$MARS_CONNECT_HOST:$MARS_PORT/workspaces"

exec mars-server \
  --workspace "$MARS_WORKSPACE" \
  --host 0.0.0.0 \
  --port "$MARS_PORT" \
  --token "$MARS_TOKEN" \
  --host-token "$MARS_HOST_TOKEN" \
  --approval "$MARS_APPROVAL_MODE" \
  --cors "$MARS_CORS_ORIGINS" \
  --verbose
