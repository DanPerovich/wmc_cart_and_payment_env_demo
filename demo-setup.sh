#!/usr/bin/env bash
# Provision a fresh demo environment in WireMock Cloud, point the app at it and start the app.
# See `./demo-setup.sh --help`, or tools/setup-demo.mjs for what it does.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 18+ is required" >&2; exit 1; }
exec node tools/setup-demo.mjs "$@"
