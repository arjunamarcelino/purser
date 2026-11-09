# Deploy web Purser (Coolify atau Easypanel)

Yang di-deploy hanya dua situs statis, dari satu `Dockerfile` di root repo:

| Service | Isi | Contoh domain |
|---|---|---|
| `purser-board` | operator board (`app/`) | `board.domainkamu.com` |
| `purser-landing` | halaman produk (`landing/`) | `domainkamu.com` |

Kontrak sudah berjalan di testnet (`purser.demo.arjuna-purser.testnet`), jadi tidak perlu di-deploy lagi.

**Jangan deploy `proposer/` dan `relayer/`** dan jangan masukkan isi `.env.testnet` ke panel. Keduanya memegang
private key. Semua variabel di panduan ini publik karena dibekukan ke dalam bundle saat build.

## 1. Persiapan

1. Commit dan push `Dockerfile`, `.dockerignore`, `deploy/nginx.conf` ke branch yang akan di-deploy.
2. Arahkan DNS kedua domain (record A) ke IP server.
3. Hubungkan GitHub ke panel. Repo ini private, jadi pakai GitHub App (Coolify) atau token GitHub (Easypanel).

Deploy board dulu, karena landing butuh URL board.

## 2. Variabel build

**Board**

| Variabel | Nilai | Wajib |
|---|---|---|
| `WEB_TARGET` | `app` | ya |
| `PURSER_CONTRACT_ID` | `purser.demo.arjuna-purser.testnet` | ya |
| `NEAR_RPC_URL` | default `https://test.rpc.fastnear.com` | tidak |

**Landing**

| Variabel | Nilai | Wajib |
|---|---|---|
| `WEB_TARGET` | `landing` | ya |
| `VITE_APP_URL` | `https://board.domainkamu.com/?task=demo-20261108071557&units=1` | ya, tanpa ini link ke board disembunyikan |

Variabel ini dipakai saat build, jadi setiap perubahan nilainya butuh **rebuild/redeploy**, bukan restart.

## 3A. Coolify

Ulangi untuk kedua service:

1. Buka project, pilih **New Resource**, lalu **Private Repository (with GitHub App)**.
2. Pilih repo `purser` dan branch `main`.
3. Build Pack: **Dockerfile**.
4. Base Directory: `/`. Dockerfile Location: `/Dockerfile`.
5. Ports Exposes: `80`.
6. Domains: isi domain lengkap dengan `https://`.
7. Tab **Environment Variables**: isi variabel dari langkah 2. Pastikan tiap variabel tersedia saat build.
8. Klik **Deploy** dan tunggu status healthy.

## 3B. Easypanel

Ulangi untuk kedua service:

1. Buka project, pilih **+ Service**, lalu **App**. Beri nama `purser-board` atau `purser-landing`.
2. Tab **Source**: pilih **GitHub**, isi owner `arjunamarcelino`, repo `purser`, branch `main`, Build Path `/`.
3. Tab **Build**: pilih **Dockerfile**, file `Dockerfile`.
4. Tab **Environment**: isi variabel dari langkah 2. Easypanel meneruskannya sebagai build argument.
5. Tab **Domains**: tambahkan domain, arahkan ke port `80`.
6. Klik **Deploy**.

Easypanel juga meneruskan variabel level project ke build, jadi jangan simpan secret di project ini.

## 4. Cek hasilnya

1. `https://board.domainkamu.com/healthz` menjawab `ok`.
2. `https://board.domainkamu.com/?task=demo-20261108071557&units=1` menampilkan budget 90 dari 100 terpakai dan
   status invariant hijau.
3. Di landing, link ke board membuka task yang sama, lengkap dengan `&units=1`. Kalau bagian setelah `&` hilang,
   aktifkan opsi literal pada variabel itu di panel, lalu redeploy.
4. Hubungkan wallet owner dan pastikan pilihan NEAR CLI dan Meteor muncul.

## 5. Bedanya dengan `make board` di laptop

- Tombol **Run attack demo** dan **Run tests** tidak ada, karena hanya hidup di dev server.
- Baris REFUSED dan link transaksi di Manifest tidak muncul, karena sumbernya catatan proposer lokal.
- `?baseline=1` tidak tersedia.
- Riwayat dari indexer mati. `INDEXER_ENABLED` jangan diisi, karena build produksi tidak punya proxy ke indexer.
- Board tetap bisa dibuka siapa saja, tetapi aksi owner hanya berhasil dari wallet owner, karena kontrak yang menolak.

Untuk memutar demo saat board sudah online, jalankan `make demo` dari laptop lalu buka task barunya di board.

## 6. Masalah umum

| Gejala | Penyebab | Solusi |
|---|---|---|
| Build gagal `WEB_TARGET must be landing or app` | variabel tidak sampai ke build | cek nama dan opsi build di panel |
| Build gagal `PURSER_CONTRACT_ID is required` | variabel board belum diisi | isi lalu redeploy |
| Halaman board kosong | nilai kontrak salah, harus akun `.testnet` | perbaiki lalu redeploy |
| Board sering stale atau error `429` | RPC publik membatasi request | ganti `NEAR_RPC_URL` dengan RPC `https` lain, lalu redeploy |
| Bad Gateway | port salah | set port ke `80` |

## Coba image di lokal

```bash
docker build -t purser-board --build-arg WEB_TARGET=app \
  --build-arg PURSER_CONTRACT_ID=purser.demo.arjuna-purser.testnet .
docker run --rm -p 8080:80 purser-board
# buka http://localhost:8080/?task=demo-20261108071557&units=1
```
