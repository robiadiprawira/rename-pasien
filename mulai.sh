#!/bin/sh
# Mac/Linux: butuh python3 (sudah ada di sebagian besar sistem)
cd "$(dirname "$0")"
echo "Buka http://localhost:8765/index.html di browser. Tekan Ctrl+C untuk berhenti."
(sleep 1; command -v xdg-open >/dev/null && xdg-open http://localhost:8765/index.html || open http://localhost:8765/index.html) 2>/dev/null &
python3 -m http.server 8765 --bind 127.0.0.1
