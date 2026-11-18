# Rename File Pasien (offline)

Aplikasi web yang berjalan sepenuhnya di komputer sendiri. Tanpa internet, tanpa akun, tanpa data keluar.

## Cara menjalankan
Salin seluruh folder `rename-pasien` ke komputer mana pun, lalu:

- **Windows (disarankan, cara paling aman):** klik ganda **`Mulai.bat`**. Browser akan terbuka otomatis. Biarkan jendela hitamnya tetap terbuka selama dipakai, tutup jendela itu untuk berhenti.
- **Mac:** klik ganda **`Mulai.command`**. Jika macOS menolak ("tidak dikenal"), klik kanan file itu > Open > Open. Jika muncul "permission denied", buka Terminal lalu ketik `chmod +x ` (ada spasi di akhir), seret `Mulai.command` ke jendela Terminal, tekan Enter, lalu coba lagi. Jangan klik ganda `mulai.sh`: Mac akan membukanya sebagai teks.
- **Linux:** jalankan `sh mulai.sh` di terminal (butuh python3).
- Alternatif: klik ganda `index.html`. Ini cukup untuk PDF referensi yang teksnya bisa dibaca, tetapi **PDF hasil scan hanya bisa dibaca lewat Mulai.bat / mulai.sh**.

Disarankan memakai Chrome atau Edge.

## Cara memakai
1. **Upload PDF referensi.** Yang diambil: No Kunjungan dan Nama Pasien. Nomor urut = urutan baris dari atas ke bawah.
   - PDF yang teksnya bisa dibaca: langsung terbaca dan akurat.
   - PDF hasil scan: dibaca dengan OCR (butuh sekitar 1 sampai 3 menit per halaman). **OCR tidak 100% akurat**, jadi tabel "Data pasien yang terbaca" harus dicek. Kotak merah/kuning menandakan nilai yang mencurigakan. Isian bisa langsung diedit, dan PDF asli ditampilkan di sebelahnya untuk dicocokkan.
2. **Upload file pasien** (banyak file sekaligus). Nama file harus berisi nama pasien, misalnya `SITI LOMRAH.pdf`.
3. **Cek preview.** Hijau = cocok. Kuning = nama mirip atau kembar, cek manual. Merah = tidak cocok, pilih pasien yang benar lewat menu di barisnya.
4. **Unduh ZIP.** Hasil: `1. 0219B0071026P000044.pdf`, `2. 0219B0071026P000055.pdf`, dst. Format nama bisa diubah di kolom "Format nama baru".

## Nama kembar
Dua pasien dengan nama sama (misalnya dua "WULANDARI") tidak bisa dibedakan dari nama saja. Aplikasi memasangkan file berurutan (`WULANDARI.pdf` dulu, lalu `WULANDARI (1).pdf`) dan menandainya kuning. **Cek dan tukar manual jika terbalik**, misalnya dengan melihat tanggal atau isi file.

## Catatan keamanan
- File asli tidak pernah diubah atau dihapus, hasil selalu berupa salinan.
- Tidak ada data yang disimpan. Menutup atau me-refresh tab menghapus semuanya dari memori.
- File yang belum cocok tetap masuk ZIP di folder `belum-cocok` dengan nama aslinya.

## Isi folder
- `Mulai.bat`, `server.ps1` (Windows), `Mulai.command` (Mac), `mulai.sh` (Linux) : menjalankan server lokal (hanya bisa diakses dari komputer ini)
- `index.html`, `style.css`, `app.js` : tampilan dan alur
- `logic.js` : pembacaan PDF, OCR, pencocokan nama
- `lib/` : pdf.js, JSZip, Tesseract OCR beserta data bahasa (sudah disertakan agar jalan offline)
