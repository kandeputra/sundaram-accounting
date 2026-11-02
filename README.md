# Sundaram Accounting

Aplikasi akuntansi untuk **PT. Bali Sundaram Travel** (tour & travel), dibuat dari format Budget Report perusahaan.

- **Booking Tour** per tamu/agen dengan format Budget Report: pemasukan paket, transport (armada kantor atau vendor), pengeluaran tour, komisi vendor, pengembalian expenses
- Rekap **Grand Total**, **Transport & armada**, dan **Komisi** per periode
- Jurnal otomatis berbasis **akrual**: pendapatan dan biaya diakui saat tour selesai
- Transaksi kas/bank, angsuran leasing (pokok & bunga), invoice agen, jurnal umum, buku besar
- Laporan **Laba Rugi bertingkat**, **Neraca**, **Arus Kas**, **Neraca Saldo**, ekspor CSV
- Login per pengguna (Admin, Editor, Hanya lihat), riwayat aktivitas, backup & impor JSON
- Data tersimpan di **MySQL/MariaDB** server sendiri

## Struktur

```
app/index.html              aplikasi (satu file HTML)
data/                       backup data keuangan (impor lewat Pengaturan)
server/server.js            server Node.js (Express)
server/db.js                koneksi & pembuatan tabel otomatis
server/schema.sql           skema tabel (referensi)
server/books.json           konfigurasi buku
server/.env.example         contoh konfigurasi
server/scripts/create-admin.js   buat/reset akun admin
```

Kebutuhan: **Node.js 18+**, **MySQL 5.7+ / MariaDB 10.3+**.

## Sundaram Accounting: aturan hitung

Setiap booking tour mengikuti format Budget Report (pemasukan paket, transport, pengeluaran tour, komisi, pengembalian expenses) dan otomatis membentuk jurnal:

| Kejadian | Jurnal |
| --- | --- |
| DP / pembayaran sebelum tour selesai | Bank (D) · Uang Muka Pelanggan (K) |
| Biaya tour dibayar sebelum tour selesai | Biaya Tour Dibayar di Muka (D) · Bank (K) |
| Tour selesai (tanggal selesai) | Piutang (D) · Pendapatan (K); Uang Muka Pelanggan (D) · Piutang (K); HPP per kategori (D) · Biaya Dibayar di Muka (K) |
| Transport armada kantor | Hanya bensin + fee driver yang menjadi HPP; ongkos transport di budget report adalah perpindahan internal |
| Transport vendor luar | Ongkos transport penuh menjadi HPP |
| Komisi vendor / cashback | Bank (D) · Pendapatan Komisi Vendor (K) |
| Pengembalian tour expenses | Kas (D) · HPP Tour Expenses (K) |
| Komisi staf (50% komisi vendor, 0,5% transport armada, Rp 10.000/tamu) | Beban Komisi Karyawan (D) · Utang Komisi Karyawan (K) |
| Angsuran leasing | Utang Leasing (D, pokok) + Beban Bunga Leasing (D, bunga) · Bank (K) |
| Prive | Prive Pemilik (ekuitas), bukan beban |
| Kasbon | Piutang Karyawan (aset), bukan beban |

Laba Rugi disusun bertingkat: Pendapatan usaha − HPP = Laba kotor − Beban operasional = Laba operasional + Pendapatan lain = Laba bersih. Neraca dipisah lancar / tidak lancar dan jangka pendek / panjang.

Data Januari 2026 hasil koreksi Budget Report tersimpan di `data/backup-sundaram-januari-2026.json`: 63 booking tour, 167 transaksi kantor, dan 57 akun. Impor lewat **Pengaturan › Impor backup JSON** (masuk sebagai admin). Repo ini harus tetap private karena berisi data keuangan.

---

## Memasang di VPS lewat panel

Langkahnya sama di semua panel: buat database, unggah kode, isi `.env`, jalankan aplikasi Node dengan folder `server` sebagai root aplikasi, lalu arahkan domain ke aplikasi itu.

### 1. Buat database

Di menu **Database** panel, buat:

- Nama database, misalnya `pembukuan`
- User database dan password-nya, beri akses penuh ke database itu

Catat nama database, user, dan password. Tabel dibuat otomatis oleh aplikasi saat pertama jalan.

### 2. Ambil kode

Lewat terminal panel (atau SSH):

```bash
cd /www/wwwroot            # aaPanel. CloudPanel: /home/<user-situs>/htdocs
git clone https://github.com/kandeputra/sundaram-accounting.git
cd sundaram-accounting/server
npm install --omit=dev
cp .env.example .env
```

Alternatif: unduh ZIP dari GitHub lalu unggah lewat File Manager panel.

### 3. Isi file `server/.env`

Buka `server/.env` di File Manager dan isi:

```ini
PORT=3000
DB_HOST=127.0.0.1
DB_NAME=pembukuan
DB_USER=pembukuan
DB_PASSWORD=password-database-anda
SESSION_SECRET=   # 64 karakter acak, lihat perintah di bawah
SETUP_TOKEN=      # kode bebas, dipakai sekali untuk membuat admin pertama
```

Buat `SESSION_SECRET` dengan:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Jalankan aplikasi

**aaPanel** — menu *Website › Node project › Add Node project*
- Project directory: `/www/wwwroot/sundaram-accounting/server`
- Run command / startup: `npm start` (atau file `server.js`)
- Port: `3000`, Node version: 18 atau lebih baru
- Isi domain, lalu aktifkan SSL di tab *SSL* (Let's Encrypt)

**CloudPanel** — *Add Site › Create a Node.js Site*
- Domain, Node.js version 18+, App Port `3000`
- Kode di `/home/<user>/htdocs/<domain>/`; jalankan dengan PM2 lewat SSH:
  ```bash
  cd /home/<user>/htdocs/<domain>/sundaram-accounting/server
  npm install --omit=dev
  npx pm2 start server.js --name pembukuan
  npx pm2 save
  ```
- Aktifkan SSL di tab *SSL/TLS*

**cPanel** — *Setup Node.js App › Create Application*
- Node.js version 18+, Application mode: Production
- Application root: `sundaram-accounting/server`, Application startup file: `server.js`
- Klik *Run NPM Install*, lalu *Start*
- Jika MySQL hanya bisa lewat socket, isi `DB_SOCKET` di `.env` dan kosongkan `DB_HOST`
- Nama database & user di cPanel biasanya berawalan nama akun, misalnya `akun_pembukuan`

### 5. Buat akun admin pertama

Buka `https://domainanda.com/sundaram/`. Karena belum ada pengguna, muncul form **Buat akun admin pertama**: masukkan `SETUP_TOKEN` dari `.env`, lalu username dan password admin.

Setelah admin dibuat, **kosongkan `SETUP_TOKEN`** di `.env` dan restart aplikasi.

Cara lain lewat terminal:

```bash
cd sundaram-accounting/server
npm run create-admin -- kande PasswordKuat123 "Kande Putra"
```

Perintah yang sama juga untuk mereset password admin yang lupa.

### 6. Tambah staf

Masuk sebagai admin › menu **Pengguna** › **Tambah pengguna**, lalu pilih perannya.

---

## Memindahkan data dari aplikasi di Claude

1. Buka aplikasi di Claude › **Pengaturan** › **Unduh backup JSON**.
2. Buka aplikasi di server, masuk sebagai admin › **Pengaturan** › **Impor backup JSON**, pilih file tadi.

Impor mengganti seluruh isi buku tersebut di server. Ulangi untuk buku yang lain.

## Backup rutin

Data ada di database MySQL. Backup dengan fitur backup database di panel (atur jadwal harian), atau:

```bash
mysqldump -u pembukuan -p pembukuan > backup-pembukuan-$(date +%F).sql
```

Admin juga bisa mengunduh backup JSON per buku dari menu **Pengaturan**.

## Memperbarui aplikasi

```bash
cd sundaram-accounting
git pull
cd server && npm install --omit=dev
```

Lalu restart aplikasi dari panel (atau `npx pm2 restart pembukuan`).

## Pengaturan lain di `.env`

| Nama | Fungsi |
| --- | --- |
| `BASE_PATH` | Jika dipasang di sub-folder, misal `/akunting` |
| `SESSION_DAYS` | Lama login tetap aktif (default 14 hari) |
| `COOKIE_SECURE` | `auto` mengikuti HTTPS dari panel. Isi `true` jika login tidak bertahan di HTTPS. |
| `HOST` | `127.0.0.1` (default) hanya bisa diakses lewat domain/panel |

## Keamanan

- Password disimpan sebagai hash bcrypt.
- Sesi login memakai cookie HttpOnly bertanda tangan; mengganti password atau menonaktifkan akun langsung memutus sesi lama.
- 10 kali gagal login dari satu IP dikunci 15 menit.
- Wajib pakai HTTPS (aktifkan SSL di panel).

## Membuka tanpa server

`app/index.html` bisa dibuka langsung di browser tanpa server. Dalam mode itu data hanya tersimpan di browser tersebut.
