# OneBook web app

The reader for [OneBook](https://github.com/makestreme/onebook_setup), a book-shaped ESP32-S3 server that holds your EPUB library. It's a static web app with no build step. It talks to your OneBook only through your own Cloudflare Worker, so one hosted copy works for everyone.

**Open it: https://makestreme.github.io/onebook/**

The firmware, Cloudflare Worker and setup guide are in **[makestreme/onebook_setup](https://github.com/makestreme/onebook_setup)**. To connect this app to your OneBook, follow [step 8 of the setup guide](https://github.com/makestreme/onebook_setup/blob/main/SETUP.md#8-connect-the-web-app).

## What it does
- Shows the library on your OneBook, with covers, and lets you upload and delete books.
- Downloads each book once and keeps it in the browser, so books open instantly and can be read offline.
- Renders EPUBs with themes, font choice and size, and a two-page spread on wide screens.
- Syncs reading position and named bookmarks with OneBook, so you can continue on another device.
- Installs as an app (Add to Home screen / Install).

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `app.js` | All app logic: settings, library, upload, reader, bookmark sync |
| `app.css` | Styles and reader themes |
| `sw.js` | Service worker: caches the app so it opens offline |
| `manifest.webmanifest`, `icons/` | Install as an app |
| `lib/` | [epub.js](https://github.com/futurepress/epub.js) 0.3.93 and [JSZip](https://stuk.github.io/jszip/) 3.10.1, bundled so no CDN is needed |

## Where data is stored
Everything stays in the browser on each device:
- **Settings** (Worker address and access token) and reader preferences: `localStorage`.
- **Downloaded books, covers and bookmarks:** IndexedDB.

Clearing the site's data in the browser removes them. Bookmarks also live on OneBook, so they come back on the next sync.

## Hosting
This repository is published with GitHub Pages: **Settings → Pages → Source: Deploy from a branch → `main`, `/ (root)`**.

To host your own copy, fork this repository and enable Pages the same way, or put the files on any HTTPS static host. Then set `ALLOWED_ORIGIN` in the Worker's [wrangler.toml](https://github.com/makestreme/onebook_setup/blob/main/worker/wrangler.toml) to your site's origin (for example `https://you.github.io`, no path) and redeploy the Worker. Several origins can be listed, comma-separated.

## Testing locally
Serve this folder with any static server and open it in a browser, for example:
```
npx serve .
```
or
```
python -m http.server 8000
```
The Worker only accepts requests from `ALLOWED_ORIGIN`. To test against a real Worker, add the local address to it, comma-separated (for example `"https://makestreme.github.io,http://localhost:8000"`), and redeploy.

## Releasing changes
The service worker loads the network copy first, so changes appear on the next visit. If you add or rename files, list them in `SHELL` in `sw.js` and bump `CACHE` (for example `onebook-v2`).

## Credits
[epub.js](https://github.com/futurepress/epub.js) (BSD 2-Clause) and [JSZip](https://github.com/Stuk/jszip) (MIT) for EPUB rendering.
