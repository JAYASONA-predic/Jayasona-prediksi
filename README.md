# JAYASONA PREDIKSI V3 — MBox888 Sync

Versi ini mengganti database demo V2 dengan database hasil yang disinkronkan oleh GitHub Actions dari:

https://www.mbox888.com/_View/Result.aspx

## Struktur
- `index.html` — aplikasi Match Center
- `data.json` — database hasil yang dibuat oleh sync
- `scripts/sync_mbox.py` — scraper/parser MBox888
- `scripts/requirements.txt` — dependency Python
- `.github/workflows/sync-mbox.yml` — sinkronisasi otomatis setiap 15 menit
- `manifest.json`, `sw.js`, `icon.svg` — PWA

## Instalasi ke repository yang sudah ada
1. Backup repository V2.
2. Upload/replace file V3 ke branch `main`.
3. Pastikan folder `.github/workflows/` dan `scripts/` ikut ter-upload.
4. Pastikan `index.html` dan `data.json` berada di root repository.
5. Commit perubahan.
6. Buka tab **Actions**.
7. Pilih **Sync MBox888 Results**.
8. Tekan **Run workflow** untuk tes pertama.
9. Jika hijau, GitHub Actions akan menjalankan sinkronisasi terjadwal.

## Catatan penting
- GitHub Pages hanya menyajikan file statis; pengambilan MBox888 dilakukan di GitHub Actions.
- Parser memakai guard: jika hasil parsing 0 pertandingan, `data.json` tidak ditimpa agar database lama tidak hilang karena perubahan struktur sumber.
- MBox888 dapat mengubah struktur halaman sewaktu-waktu. Jika workflow gagal, lihat log Actions.
- Data dari sumber pihak ketiga harus digunakan sesuai ketentuan/izin sumber tersebut.
