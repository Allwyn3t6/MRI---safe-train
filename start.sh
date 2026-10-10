#!/usr/bin/env sh
# MRISafe Twin - start the local server and open the app in your browser
cd "$(dirname "$0")"
PY=python3; command -v python3 >/dev/null 2>&1 || PY=python
exec "$PY" server/server.py --open "$@"
