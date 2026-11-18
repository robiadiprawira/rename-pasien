#!/bin/sh
# Mac: klik ganda file ini (atau klik kanan > Open saat pertama kali).
cd "$(dirname "$0")"
echo "Rename File Pasien berjalan di http://localhost:8765/index.html"
echo "Biarkan jendela ini terbuka selama dipakai. Tutup jendela ini untuk berhenti."
(sleep 1; open "http://localhost:8765/index.html") &
python3 -m http.server 8765 --bind 127.0.0.1
