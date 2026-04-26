# GDI Worker (Google Drive Index)

Worker terpisah yang jadi proxy ke Google Drive — listing folder + streaming video.

URL produksi: <https://indexgoogle.zaeinstream.workers.dev>

## Setup pertama kali

```bash
cd gdi-worker
wrangler login
wrangler secret put CLIENT_ID         # Google OAuth client_id
wrangler secret put CLIENT_SECRET     # Google OAuth client_secret
wrangler secret put REFRESH_TOKEN     # Google OAuth refresh_token
wrangler secret put GDI_USER          # username untuk login GDI (1 user)
wrangler secret put GDI_PASS          # password untuk login GDI
wrangler deploy
```

## Cara dapat Google OAuth credentials

Ikuti panduan resmi: <https://gitlab.com/GoogleDriveIndex/Google-Drive-Index>

Step ringkas:
1. Buka <https://console.cloud.google.com>
2. Buat project baru → enable Google Drive API
3. Buat OAuth 2.0 Client ID (type: Web application)
4. Generate refresh token via OAuth playground atau script gdi.js.org

## Roots yang dikonfigurasi

Ada di [`indexgoogle.js`](./indexgoogle.js) bagian `roots`:
- "My Drive" (root)
- "Drive Folder" (`1kuu3LQBiit-U-_98MAOBTOyrRMnVVA7C`)
- "Shared Folder" (`1SPeBCBNFU3s0m2NPuIJzgyAQTUWU3wMx`)
- "Shared Drive" (`0AI96FDDLWPh5Uk9PVA`)
