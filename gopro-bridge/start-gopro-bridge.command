#!/bin/bash
# Double-click launcher for the GoPro bridge (macOS).
# First run installs the one dependency (ws); afterwards it just starts the bridge.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (https://nodejs.org). Install it, then re-run."; read -r _; exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required (brew install ffmpeg). Install it, then re-run."; read -r _; exit 1
fi
if [ ! -d node_modules ]; then echo "Installing dependencies…"; npm install || { read -r _; exit 1; }; fi
echo "Starting GoPro bridge. Keep this window open; close it (or Ctrl-C) to stop."
node bridge.js
read -r _
