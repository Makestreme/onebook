'use strict';

(() => {
  // ---------------- Constants ----------------
  const CFG_KEY = 'onebook.config';
  const PREFS_KEY = 'onebook.reader';
  const LIB_KEY = 'onebook.library|';
  const MAX_BOOK_BYTES = 20 * 1024 * 1024;   // must match firmware MAX_BOOK_BYTES
  const MIN_FREE_BYTES = 50 * 1024 * 1024;   // must match firmware MIN_FREE_BYTES
  const MAX_NAME_LEN = 100;                  // must match firmware MAX_UPLOAD_NAME
  const MAX_DOC_BYTES = 15 * 1024;           // firmware accepts 16 KB of bookmark JSON per book
  const MAX_META_BYTES = 60 * 1024;          // firmware accepts 64 KB of metadata per book
  const MAX_MARKS = 50;
  const LAST_SYNC_MS = 30000;
  const MARK_SYNC_MS = 1500;
  const TOMBSTONE_MS = 90 * 24 * 3600 * 1000;
  const FONT_STACK = {
    serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  };
  const THEMES = {
    light: { bg: '#fdfcf8', fg: '#1d1d1f', link: '#1a5fb4' },
    sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a4b1c' },
    dark: { bg: '#15171a', fg: '#d8d6d0', link: '#8ab4f8' },
  };

  // ---------------- Small helpers ----------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const enc = encodeURIComponent;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }

  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'ic');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#i-' + name);
    s.append(u);
    return s;
  }

  function loadJSON(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
  }

  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1e3)) + ' KB';
  }

  function fmtUptime(s) {
    const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
  }

  function relTime(t) {
    if (!t) return '';
    const days = Math.round((Date.now() - t) / 864e5);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(t).toLocaleDateString();
  }

  function hashHue(s) {
    let x = 0;
    for (const c of s) x = (x * 31 + c.codePointAt(0)) >>> 0;
    return x % 360;
  }

  const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
  const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
  const stripExt = n => n.replace(/\.epub$/i, '');
  const pctText = p => (p == null ? '' : Math.round(p * 100) + '%');

  let toastTimer = null;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------------- Settings ----------------
  let cfg = Object.assign({ url: '', token: '' }, loadJSON(CFG_KEY, {}));
  const prefs = Object.assign({ theme: 'light', fontSize: 100, font: 'publisher', spread: true }, loadJSON(PREFS_KEY, {}));
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const key = name => cfg.url + '|' + name;

  function normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return new URL(u).origin;
  }

  // ---------------- IndexedDB ----------------
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('onebook', 1);
        req.onupgradeneeded = () => {
          for (const s of ['books', 'meta', 'marks', 'locations']) {
            if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function idb(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const idbGet = (s, k) => idb(s, 'readonly', st => st.get(k));
  const idbPut = (s, k, v) => idb(s, 'readwrite', st => st.put(v, k));
  const idbDel = (s, k) => idb(s, 'readwrite', st => st.delete(k));
  const idbKeys = s => idb(s, 'readonly', st => st.getAllKeys());

  // ---------------- Server API ----------------
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(method, path, opts = {}, conf = cfg) {
    if (!conf.url) throw new ApiError(0, 'Server not set up');
    let res;
    try {
      res = await fetch(conf.url + path, {
        method,
        body: opts.body,
        signal: opts.signal,
        keepalive: opts.keepalive,
        cache: 'no-store',
        headers: Object.assign({ Authorization: 'Bearer ' + conf.token }, opts.headers),
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError(0, 'Cannot reach the server');
    }
    if (!res.ok) {
      let msg = res.statusText || 'Request failed';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
      throw new ApiError(res.status, msg);
    }
    return res;
  }

  function errText(e) {
    if (!e) return 'Something went wrong';
    if (e.name === 'AbortError') return 'Cancelled';
    if (e.status === 401 || e.status === 403) return 'Access denied - check your token';
    if (e.status === 0) return e.message || 'Cannot reach the server';
    if (e.status === 507) return 'Not enough space on OneBook';
    return e.message || `Error ${e.status}`;
  }

  function xhrUpload(path, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', cfg.url + path);
      x.setRequestHeader('Authorization', 'Bearer ' + cfg.token);
      x.setRequestHeader('Content-Type', 'application/epub+zip');
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.upload.onload = () => onProgress(1);
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) return resolve();
        let msg = x.statusText || 'Upload failed';
        try { msg = JSON.parse(x.responseText).error || msg; } catch { /* not JSON */ }
        reject(new ApiError(x.status, msg));
      };
      x.onerror = () => reject(new ApiError(0, 'Cannot reach the server'));
      x.send(blob);
    });
  }

  // ---------------- Library state ----------------
  const state = {
    books: [],          // [{ n: name, s: size, m: hasServerMeta }]
    status: null,
    online: false,
    meta: new Map(),    // name -> { title, author, cover, size }
    local: new Set(),   // names downloaded in this browser
    query: '',
    lastRefresh: 0,
  };

  const titleOf = (name, meta) => (meta && meta.title) || stripExt(name);

  function setConn(kind, text) {
    const p = $('#connPill');
    p.className = 'pill ' + kind;
    p.textContent = text;
  }

  async function refreshLibrary() {
    if (!cfg.url) {
      state.books = [];
      state.status = null;
      state.online = false;
      setConn('', 'Not set up');
      renderLibrary();
      return;
    }
    setConn('busy', 'Connecting...');
    try {
      state.status = await (await api('GET', '/api/status')).json();
      const list = await (await api('GET', '/api/books')).json();
      state.books = Array.isArray(list.books) ? list.books.filter(b => b && typeof b.n === 'string') : [];
      state.online = true;
      state.lastRefresh = Date.now();
      localStorage.setItem(LIB_KEY + cfg.url, JSON.stringify({ books: state.books, status: state.status }));
      setConn('online', 'Connected');
    } catch (e) {
      state.online = false;
      const cached = loadJSON(LIB_KEY + cfg.url, null);
      if (cached) {
        state.books = cached.books || [];
        state.status = cached.status || null;
      }
      if (e.status === 401 || e.status === 403) setConn('error', 'Access denied');
      else setConn('error', (e.status === 0 ? 'Offline' : e.message) + ' - showing downloaded books');
    }
    await loadLocalState();
    renderLibrary();
    if (state.online) {
      fetchMissingMeta();
      syncDirtyDocs();
    }
  }

  async function loadLocalState() {
    const prefix = cfg.url + '|';
    try {
      const keys = await idbKeys('books');
      state.local = new Set(keys.filter(k => typeof k === 'string' && k.startsWith(prefix)).map(k => k.slice(prefix.length)));
      for (const b of state.books) {
        if (state.meta.has(b.n)) continue;
        const m = await idbGet('meta', key(b.n));
        if (m) state.meta.set(b.n, m);
      }
    } catch (e) {
      console.warn('Local storage unavailable', e);
    }
  }

  function sanitizeMeta(m) {
    m = m && typeof m === 'object' ? m : {};
    const cover = typeof m.cover === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(m.cover) ? m.cover : null;
    return { v: 1, title: str(m.title, 200), author: str(m.author, 200), cover };
  }

  let metaRun = 0;
  async function fetchMissingMeta() {
    const run = ++metaRun;
    for (const b of [...state.books]) {
      if (run !== metaRun || !state.online) return;
      const cached = state.meta.get(b.n);
      if (!b.m || (cached && cached.size === b.s)) continue;
      try {
        const meta = sanitizeMeta(await (await api('GET', '/api/meta/' + enc(b.n))).json());
        meta.size = b.s;
        state.meta.set(b.n, meta);
        await idbPut('meta', key(b.n), meta);
        scheduleRender();
      } catch (e) {
        if (e.status === 0) return;
      }
    }
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderLibrary(); });
  }

  function renderStorage() {
    const sd = state.status && state.status.sd;
    const fill = $('#storageFill');
    const text = $('#storageText');
    if (sd && sd.ok && sd.total) {
      fill.style.width = Math.min(100, (sd.used / sd.total) * 100) + '%';
      text.textContent = `${fmtBytes(sd.used)} of ${fmtBytes(sd.total)} used`;
      fill.parentElement.classList.remove('hidden');
    } else {
      fill.parentElement.classList.add('hidden');
      text.textContent = sd && !sd.ok ? 'SD card not available' : '';
    }
  }

  function showEmpty(title, text, actionText, action) {
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
    const btn = $('#emptyAction');
    btn.classList.toggle('hidden', !actionText);
    btn.textContent = actionText || '';
    btn.onclick = action || null;
    $('#emptyState').classList.remove('hidden');
  }

  function renderLibrary() {
    renderStorage();
    const grid = $('#grid');
    grid.replaceChildren();
    $('#emptyState').classList.add('hidden');

    if (!cfg.url) {
      showEmpty('Connect your OneBook', 'Enter your server address and access token to see your library.', 'Open settings', openSettings);
      return;
    }
    if (!state.books.length) {
      if (state.online) showEmpty('Your shelf is empty', 'Upload EPUB files to fill your OneBook.', 'Upload books', openUpload);
      else showEmpty('Cannot reach OneBook', 'Check that it is powered on and connected, then refresh.', 'Retry', refreshLibrary);
      return;
    }

    const q = state.query.trim().toLowerCase();
    const items = state.books
      .map(b => ({ b, m: state.meta.get(b.n) }))
      .filter(({ b, m }) => !q || [b.n, m && m.title, m && m.author].some(s => s && s.toLowerCase().includes(q)))
      .sort((x, y) => titleOf(x.b.n, x.m).localeCompare(titleOf(y.b.n, y.m), undefined, { sensitivity: 'base', numeric: true }));

    if (!items.length) {
      showEmpty('No matches', `Nothing in your library matches "${state.query.trim()}".`);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const { b, m } of items) frag.append(bookCard(b, m));
    grid.append(frag);
  }

  function bookCard(b, m) {
    const title = titleOf(b.n, m);
    const isLocal = state.local.has(b.n);
    const cover = m && m.cover
      ? h('img', { src: m.cover, alt: '', loading: 'lazy' })
      : h('div', { class: 'ph', style: `--h:${hashHue(title)}` }, h('span', { text: title }));
    return h('li', { class: 'card' + (state.online || isLocal ? '' : ' unavailable') },
      h('button', { class: 'cover', 'aria-label': 'Open ' + title, onclick: () => openBook(b.n) },
        cover,
        isLocal ? h('span', { class: 'badge', title: 'Available offline' }, icon('check')) : null),
      h('div', { class: 'info' },
        h('div', { class: 'title', text: title, title }),
        h('div', { class: 'author', text: (m && m.author) || '' }),
        h('div', { class: 'row' },
          h('span', { text: fmtBytes(b.s) }),
          h('button', { class: 'icon-btn small', 'aria-label': 'More actions for ' + title, onclick: () => bookMenu(b) }, icon('more')))));
  }

  function bookMenu(b) {
    const m = state.meta.get(b.n);
    const isLocal = state.local.has(b.n);
    $('#menuTitle').textContent = titleOf(b.n, m);
    $('#menuSub').textContent = [m && m.author, fmtBytes(b.s), isLocal ? 'Downloaded' : null].filter(Boolean).join(' · ');
    const items = $('#menuItems');
    items.replaceChildren();
    const dlg = $('#dlgMenu');
    const add = (label, ic, fn, cls) => items.append(h('button', {
      class: 'btn' + (cls ? ' ' + cls : ''),
      onclick: () => { dlg.close(); fn(); },
    }, icon(ic), label));
    add('Read', 'book', () => openBook(b.n));
    if (isLocal) add('Remove download', 'close', () => removeDownload(b.n));
    else if (state.online) add('Download for offline reading', 'download', () => downloadBook(b.n));
    if (state.online) add('Delete from OneBook', 'trash', () => deleteBook(b), 'danger');
    dlg.showModal();
  }

  // ---------------- Downloads ----------------
  let busyCancel = null;
  function showBusy(text, onCancel) {
    $('#busyText').textContent = text;
    $('#busySub').textContent = '';
    $('#busyFill').style.width = '0';
    busyCancel = onCancel || null;
    $('#busyCancel').classList.toggle('hidden', !onCancel);
    $('#busy').classList.remove('hidden');
  }
  function updateBusy(frac, sub) {
    $('#busyFill').style.width = frac == null ? '0' : Math.round(frac * 100) + '%';
    $('#busySub').textContent = sub || '';
  }
  function hideBusy() {
    $('#busy').classList.add('hidden');
    busyCancel = null;
  }

  async function downloadBook(name) {
    const b = state.books.find(x => x.n === name);
    const ctrl = new AbortController();
    showBusy('Downloading ' + titleOf(name, state.meta.get(name)), () => ctrl.abort());
    try {
      const res = await api('GET', '/api/books/' + enc(name), { signal: ctrl.signal });
      const total = Number(res.headers.get('Content-Length')) || (b && b.s) || 0;
      let buf;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          updateBusy(total ? got / total : null, total ? `${fmtBytes(got)} of ${fmtBytes(total)}` : fmtBytes(got));
        }
        buf = await new Blob(chunks).arrayBuffer();
      } else {
        buf = await res.arrayBuffer();
      }
      if (total && buf.byteLength !== total) throw new Error('Download was incomplete');
      const rec = { name, size: buf.byteLength, buf, at: Date.now() };
      await idbPut('books', key(name), rec);
      await idbDel('locations', key(name));
      state.local.add(name);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      return rec;
    } catch (e) {
      if (e.name !== 'AbortError') toast('Download failed: ' + errText(e));
      return null;
    } finally {
      hideBusy();
      scheduleRender();
    }
  }

  async function removeDownload(name) {
    await idbDel('books', key(name));
    await idbDel('locations', key(name));
    state.local.delete(name);
    renderLibrary();
    toast('Download removed');
  }

  async function deleteBook(b) {
    const title = titleOf(b.n, state.meta.get(b.n));
    if (!await confirmDialog(`Delete "${title}" from OneBook? This removes the file and its bookmarks permanently.`, 'Delete')) return;
    try {
      await api('DELETE', '/api/books/' + enc(b.n));
    } catch (e) {
      toast('Delete failed: ' + errText(e));
      return;
    }
    for (const s of ['books', 'locations', 'meta', 'marks']) await idbDel(s, key(b.n)).catch(() => {});
    state.local.delete(b.n);
    state.meta.delete(b.n);
    state.books = state.books.filter(x => x.n !== b.n);
    toast('Deleted');
    refreshLibrary();
  }

  // ---------------- EPUB helpers ----------------
  function bookReady(book, ms = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out reading the EPUB')), ms);
      book.on('openFailed', e => { clearTimeout(t); reject(e || new Error('Not a valid EPUB')); });
      book.ready.then(() => { clearTimeout(t); resolve(); }, e => { clearTimeout(t); reject(e); });
    });
  }

  function makeThumb(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 300 / img.naturalHeight, 200 / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = hgt;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, hgt);
        ctx.drawImage(img, 0, 0, w, hgt);
        for (const q of [0.82, 0.68, 0.52, 0.38]) {
          const d = c.toDataURL('image/jpeg', q);
          if (d.length < 45000) return resolve(d);
        }
        resolve(null);
      };
      img.onerror = () => reject(new Error('Cover image could not be read'));
      img.src = url;
    });
  }

  async function metaFromBook(book) {
    const md = await book.loaded.metadata;
    let cover = null;
    try {
      const url = await book.coverUrl();
      if (url) cover = await makeThumb(url);
    } catch { /* book without a usable cover */ }
    const meta = { v: 1, title: str(md.title, 200).trim(), author: str(md.creator, 200).trim(), cover };
    if (JSON.stringify(meta).length > MAX_META_BYTES) meta.cover = null;
    return meta;
  }

  async function extractMeta(buf) {
    const book = ePub(buf);
    try {
      await bookReady(book);
      return await metaFromBook(book);
    } finally {
      try { book.destroy(); } catch { /* already gone */ }
    }
  }

  // ---------------- Upload ----------------
  function sanitizeName(fileName) {
    let base = stripExt(fileName).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    base = base.replace(/[^A-Za-z0-9 ._\-()[\],'&+!]/g, '_').replace(/_+/g, '_').replace(/\s+/g, ' ').trim();
    base = base.replace(/^[.\s_]+/, '').slice(0, MAX_NAME_LEN - 5).trim();
    return (base || 'book') + '.epub';
  }

  const uploadQueue = [];
  let uploading = false;

  function openUpload() {
    if (!cfg.url) return openSettings();
    if (!state.online) return toast('OneBook is not reachable right now');
    if (!uploading) $('#uploadList').replaceChildren();
    $('#dlgUpload').showModal();
  }

  function queueFiles(files) {
    for (const file of files) {
      const stateEl = h('div', { class: 'state', text: 'Waiting' });
      const fill = h('div');
      const row = h('li', null, h('div', { class: 'name', text: file.name }), stateEl, h('div', { class: 'meter' }, fill));
      $('#uploadList').append(row);
      uploadQueue.push({ file, stateEl, fill });
    }
    if (!uploading) runUploads();
  }

  async function runUploads() {
    uploading = true;
    let changed = false;
    while (uploadQueue.length) {
      if (await uploadOne(uploadQueue.shift())) changed = true;
    }
    uploading = false;
    if (changed) refreshLibrary();
  }

  async function uploadOne({ file, stateEl, fill }) {
    const set = (text, frac, cls) => {
      stateEl.textContent = text;
      stateEl.className = 'state' + (cls ? ' ' + cls : '');
      if (frac != null) fill.style.width = Math.round(frac * 100) + '%';
    };
    if (!/\.epub$/i.test(file.name)) { set('Not an EPUB file', null, 'err'); return false; }
    if (file.size > MAX_BOOK_BYTES) { set('Larger than 20 MB', null, 'err'); return false; }
    const sd = state.status && state.status.sd;
    if (sd && sd.ok && sd.total - sd.used < file.size + MIN_FREE_BYTES) { set('Not enough space on OneBook', null, 'err'); return false; }

    const name = sanitizeName(file.name);
    const existing = state.books.find(b => b.n.toLowerCase() === name.toLowerCase());
    if (existing && !await confirmDialog(`"${name}" is already on OneBook. Replace it?`, 'Replace')) {
      set('Skipped', null);
      return false;
    }

    set('Reading book...', 0);
    let meta;
    try {
      meta = await extractMeta(await file.arrayBuffer());
    } catch (e) {
      set('This file could not be read as an EPUB', null, 'err');
      return false;
    }

    try {
      await xhrUpload('/api/books/' + enc(name), file, frac =>
        set(frac < 1 ? `Uploading ${Math.round(frac * 100)}%` : 'Saving to OneBook...', frac));
      let metaOk = true;
      try {
        await api('PUT', '/api/meta/' + enc(name), { body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json' } });
      } catch {
        metaOk = false;
      }
      const target = existing || { n: name };
      target.s = file.size;
      target.m = metaOk;
      if (!existing) state.books.push(target);
      const localMeta = Object.assign({}, meta, { size: file.size });
      state.meta.set(target.n, localMeta);
      await idbPut('meta', key(target.n), localMeta);
      await idbDel('books', key(target.n));
      await idbDel('locations', key(target.n));
      state.local.delete(target.n);
      set(name === file.name ? 'Uploaded' : `Uploaded as "${name}"`, 1, 'ok');
      renderLibrary();
      return true;
    } catch (e) {
      set(errText(e), null, 'err');
      return false;
    }
  }

  // ---------------- Bookmark documents ----------------
  // Doc: { v:1, last:{cfi,pct,label,at}|null, marks:[{id,name,cfi,pct,label,at,c} | {id,del:true,at,c}] }
  const emptyDoc = () => ({ v: 1, last: null, marks: [] });

  function cleanPos(p) {
    return { cfi: String(p.cfi), pct: num(p.pct), label: str(p.label, 120), at: num(p.at) || 0 };
  }

  function cleanMark(m) {
    const o = { id: str(m.id, 40), at: num(m.at) || 0, c: num(m.c) || 0 };
    if (m.del) o.del = true;
    else Object.assign(o, { name: str(m.name, 80), cfi: String(m.cfi), pct: num(m.pct), label: str(m.label, 120) });
    return o;
  }

  function parseDoc(text) {
    let d;
    try { d = JSON.parse(text); } catch { return emptyDoc(); }
    const out = emptyDoc();
    if (!d || typeof d !== 'object') return out;
    if (d.last && typeof d.last.cfi === 'string' && d.last.cfi.startsWith('epubcfi(')) out.last = cleanPos(d.last);
    if (Array.isArray(d.marks)) {
      out.marks = d.marks.filter(m => m && typeof m.id === 'string' && (m.del || typeof m.cfi === 'string')).map(cleanMark);
    }
    return out;
  }

  function markOrder(x, y) {
    return ((x.del ? 1 : 0) - (y.del ? 1 : 0))
      || ((x.pct ?? 2) - (y.pct ?? 2))
      || (x.c - y.c)
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  }

  // Last-writer-wins per bookmark id and for the reading position, so devices can merge freely.
  function mergeDocs(a, b) {
    const out = emptyDoc();
    const lasts = [a.last, b.last].filter(Boolean);
    out.last = lasts.length ? lasts.reduce((x, y) => (y.at > x.at ? y : x)) : null;
    const byId = new Map();
    for (const m of [...a.marks, ...b.marks]) {
      const cur = byId.get(m.id);
      if (!cur || m.at > cur.at || (m.at === cur.at && m.del && !cur.del)) byId.set(m.id, m);
    }
    const cutoff = Date.now() - TOMBSTONE_MS;
    out.marks = [...byId.values()].filter(m => !m.del || m.at > cutoff).sort(markOrder);
    return out;
  }

  const normalizeDoc = d => mergeDocs(d, emptyDoc());
  const docKey = d => JSON.stringify(d);
  const liveMarks = d => d.marks.filter(m => !m.del);

  const locks = new Map();
  function withLock(name, fn) {
    const p = (locks.get(name) || Promise.resolve()).then(() => fn());
    locks.set(name, p.catch(() => {}));
    return p;
  }

  async function changeDoc(name, mutate) {
    return withLock(name, async () => {
      const rec = await idbGet('marks', key(name));
      const doc = rec ? rec.doc : emptyDoc();
      mutate(doc);
      const norm = normalizeDoc(doc);
      await idbPut('marks', key(name), { doc: norm, dirty: true });
      if (R.name === name) {
        R.doc = norm;
        R.dirty = true;
      }
      return norm;
    });
  }

  const syncChains = new Map();
  function syncBook(name, timeoutMs) {
    const p = (syncChains.get(name) || Promise.resolve()).catch(() => {}).then(() => doSync(name, timeoutMs));
    syncChains.set(name, p);
    p.finally(() => { if (syncChains.get(name) === p) syncChains.delete(name); }).catch(() => {});
    return p;
  }

  async function doSync(name, timeoutMs) {
    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const rec = await withLock(name, () => idbGet('marks', key(name)));
      const local = rec ? rec.doc : emptyDoc();
      let server = emptyDoc();
      try {
        server = parseDoc(await (await api('GET', '/api/bookmarks/' + enc(name), { signal: ctrl.signal })).text());
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const merged = mergeDocs(local, server);
      const serverNorm = normalizeDoc(server);
      if (docKey(merged) !== docKey(serverNorm)) {
        // Lets the device flash its LED for bookmark edits but not for routine position saves.
        const marksChanged = JSON.stringify(merged.marks) !== JSON.stringify(serverNorm.marks);
        await api('PUT', '/api/bookmarks/' + enc(name) + (marksChanged ? '?flash=1' : ''), {
          body: JSON.stringify(merged),
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
        });
      }
      return await withLock(name, async () => {
        const now = await idbGet('marks', key(name));
        const final = now ? mergeDocs(now.doc, merged) : merged;
        const dirty = docKey(final) !== docKey(merged);
        await idbPut('marks', key(name), { doc: final, dirty });
        if (R.name === name) {
          R.doc = final;
          R.dirty = dirty;
          renderMarks();
        }
        if (dirty) scheduleSync(name, MARK_SYNC_MS);
        return final;
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const syncTimers = new Map();
  function scheduleSync(name, delay) {
    const due = Date.now() + delay;
    const t = syncTimers.get(name);
    if (t && t.due <= due) return;
    if (t) clearTimeout(t.id);
    syncTimers.set(name, {
      due,
      id: setTimeout(() => {
        syncTimers.delete(name);
        if (state.online) syncBook(name).catch(() => {});
      }, delay),
    });
  }

  function flushSync(name) {
    const t = syncTimers.get(name);
    if (t) {
      clearTimeout(t.id);
      syncTimers.delete(name);
    }
    return syncBook(name).catch(() => {});
  }

  async function syncDirtyDocs() {
    const prefix = cfg.url + '|';
    let keys = [];
    try { keys = await idbKeys('marks'); } catch { return; }
    for (const k of keys) {
      if (!state.online || typeof k !== 'string' || !k.startsWith(prefix)) continue;
      const rec = await idbGet('marks', k);
      if (rec && rec.dirty) await syncBook(k.slice(prefix.length)).catch(() => {});
    }
  }

  // ---------------- Reader ----------------
  const R = { name: null, book: null, rendition: null, loc: null, toc: [], doc: null, dirty: false, size: 0, pushed: false, touch: null };

  async function openBook(name) {
    if (R.book) return;
    let rec = null;
    try { rec = await idbGet('books', key(name)); } catch { /* storage unavailable */ }
    if (!rec) {
      if (!state.online) {
        toast('This book is not downloaded and OneBook is unreachable');
        return;
      }
      rec = await downloadBook(name);
      if (!rec) return;
    }
    try {
      await openReader(name, rec);
    } catch (e) {
      console.error(e);
      toast('Could not open this book');
      closeReader();
    }
  }

  async function openReader(name, rec) {
    Object.assign(R, { name, loc: null, toc: [], doc: emptyDoc(), dirty: false, size: rec.size });
    $('#readerTitle').textContent = titleOf(name, state.meta.get(name));
    $('#readerProgress').textContent = '';
    $('#progressFill').style.width = '0';
    $('#readerLoading').classList.remove('hidden');
    $('#tocList').replaceChildren();
    renderMarks();
    showView('reader');
    history.pushState({ onebookReader: true }, '');
    R.pushed = true;
    setBars(true);

    const book = ePub(rec.buf);
    R.book = book;
    const rendition = book.renderTo('viewer', {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      spread: prefs.spread ? 'auto' : 'none',
      minSpreadWidth: 900,
      allowScriptedContent: false,
    });
    R.rendition = rendition;
    rendition.hooks.content.register(styleContents);
    rendition.on('relocated', onRelocated);
    rendition.on('keyup', onKey);
    rendition.on('click', onTap);
    rendition.on('touchstart', onTouchStart);
    rendition.on('touchend', onTouchEnd);
    applyPrefs();

    await bookReady(book);
    if (R.book !== book) return;

    const nav = await book.loaded.navigation;
    R.toc = flattenToc(nav.toc || [], 0).map(it => Object.assign(it, { idx: spineIndex(book, it.href) }));
    renderToc();

    const local = await withLock(name, () => idbGet('marks', key(name)));
    R.doc = local ? local.doc : emptyDoc();
    if (state.online) {
      try { R.doc = await syncBook(name, 6000); } catch { /* use the local copy */ }
    }
    if (R.book !== book) return;
    renderMarks();

    let target = R.doc.last ? R.doc.last.cfi : undefined;
    if (liveMarks(R.doc).length) {
      const pick = await resumeDialog(R.doc);
      if (R.book !== book) return;
      if (pick !== undefined) target = pick || undefined;
    }
    try {
      await rendition.display(target);
    } catch {
      await rendition.display();
    }
    if (R.book !== book) return;
    $('#readerLoading').classList.add('hidden');
    setTimeout(() => { if (R.book === book && !panelOpen()) setBars(false); }, 1800);

    loadLocations(name, book);
    uploadMissingMeta(name, book);
  }

  function spineIndex(book, href) {
    try {
      const s = book.spine.get(href);
      if (s) return s.index;
    } catch { /* fall through to suffix match */ }
    const base = (href || '').split('#')[0];
    if (!base) return -1;
    const hit = (book.spine.spineItems || []).find(s =>
      s.href === base || s.href.endsWith('/' + base) || base.endsWith('/' + s.href));
    return hit ? hit.index : -1;
  }

  function flattenToc(items, depth, out = []) {
    for (const it of items) {
      out.push({ label: (it.label || '').trim() || 'Untitled', href: it.href, depth });
      if (it.subitems && it.subitems.length) flattenToc(it.subitems, depth + 1, out);
    }
    return out;
  }

  async function loadLocations(name, book) {
    try {
      const cached = await idbGet('locations', key(name));
      if (cached && cached.size === R.size) {
        book.locations.load(cached.data);
      } else {
        await book.locations.generate(1200);
        if (R.book !== book) return;
        await idbPut('locations', key(name), { size: R.size, data: book.locations.save() });
      }
      if (R.book === book) {
        updateReaderProgress();
        renderMarks();
      }
    } catch (e) {
      console.warn('Could not compute page locations', e);
    }
  }

  // Books copied to the SD card from a PC have no cover/title info until first opened here.
  async function uploadMissingMeta(name, book) {
    const b = state.books.find(x => x.n === name);
    if (!state.online || !b || b.m) return;
    try {
      const meta = await metaFromBook(book);
      await api('PUT', '/api/meta/' + enc(name), { body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json' } });
      b.m = true;
      const localMeta = Object.assign({}, meta, { size: b.s });
      state.meta.set(name, localMeta);
      await idbPut('meta', key(name), localMeta);
    } catch (e) {
      console.warn('Metadata upload failed', e);
    }
  }

  function chapterLabel(index) {
    if (index == null) return '';
    let best = null;
    for (const it of R.toc) {
      if (it.idx < 0) continue;
      if (it.idx === index) { best = it; break; }
      if (it.idx < index && (!best || it.idx >= best.idx)) best = it;
    }
    return best ? best.label : `Section ${index + 1}`;
  }

  function cfiCompare(a, b) {
    try { return new ePub.CFI().compare(a, b); } catch { return NaN; }
  }

  // Pages reflow with screen size, so a bookmark counts as "here" if it falls anywhere on the visible page.
  function marksHere() {
    if (!R.loc || !R.doc || !R.loc.start) return [];
    const { start, end } = R.loc;
    return liveMarks(R.doc).filter(m => m.cfi === start.cfi
      || (end && cfiCompare(m.cfi, start.cfi) >= 0 && cfiCompare(m.cfi, end.cfi) <= 0));
  }

  function currentPct() {
    const b = R.book;
    if (!b || !R.loc || !b.locations.length()) return null;
    const p = b.locations.percentageFromCfi(R.loc.start.cfi);
    return typeof p === 'number' && isFinite(p) ? Math.round(p * 10000) / 10000 : null;
  }

  function updateReaderProgress() {
    const loc = R.loc;
    if (!loc) return;
    const parts = [chapterLabel(loc.start.index)];
    const d = loc.start.displayed;
    if (d && d.total > 1) parts.push(`page ${d.page} of ${d.total}`);
    const p = currentPct();
    if (p != null) parts.push(pctText(p));
    $('#readerProgress').textContent = parts.filter(Boolean).join(' · ');
    $('#progressFill').style.width = p != null ? (p * 100).toFixed(2) + '%' : '0';
    $('#btnMark').classList.toggle('active', marksHere().length > 0);
    for (const btn of document.querySelectorAll('#tocList button')) {
      btn.classList.toggle('current', Number(btn.dataset.idx) === loc.start.index);
    }
  }

  function onRelocated(loc) {
    R.loc = loc;
    updateReaderProgress();
    const name = R.name;
    if (!name || !loc.start || !loc.start.cfi) return;
    const pos = { cfi: loc.start.cfi, pct: currentPct(), label: chapterLabel(loc.start.index), at: Date.now() };
    changeDoc(name, d => { d.last = pos; }).catch(() => {});
    scheduleSync(name, LAST_SYNC_MS);
  }

  function next() { if (R.rendition) R.rendition.next(); }
  function prev() { if (R.rendition) R.rendition.prev(); }

  function onKey(e) {
    if (!R.rendition || document.querySelector('dialog[open]')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) next();
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) prev();
    else if (e.key === 'Escape') {
      if (panelOpen()) closePanel();
      else setBars(!$('#reader').classList.contains('bars'));
    }
  }

  function onTap(e) {
    if (R.touch && R.touch.swiped) return;
    const sel = e.view && e.view.getSelection && e.view.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (e.target && e.target.closest && e.target.closest('a')) return;
    if (panelOpen()) { closePanel(); return; }
    const frame = e.view && e.view.frameElement;
    const vr = $('#viewer').getBoundingClientRect();
    const fx = frame ? frame.getBoundingClientRect().left : vr.left;
    const x = (fx + e.clientX - vr.left) / vr.width;
    if (x < 0.28) prev();
    else if (x > 0.72) next();
    else setBars(!$('#reader').classList.contains('bars'));
  }

  function onTouchStart(e) {
    const t = e.changedTouches && e.changedTouches[0];
    if (t) R.touch = { x: t.screenX, y: t.screenY, at: Date.now(), swiped: false };
  }

  function onTouchEnd(e) {
    const t = e.changedTouches && e.changedTouches[0];
    const s = R.touch;
    if (!t || !s) return;
    const dx = t.screenX - s.x;
    const dy = t.screenY - s.y;
    if (Date.now() - s.at < 700 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      s.swiped = true;
      if (dx < 0) next(); else prev();
      setTimeout(() => { if (R.touch === s) R.touch = null; }, 400);
    } else {
      R.touch = null;
    }
  }

  function setBars(show) {
    $('#reader').classList.toggle('bars', show);
  }

  // ---------------- Reader panel ----------------
  const panelOpen = () => $('#panel').classList.contains('open');

  function openPanel(tab) {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const p of document.querySelectorAll('.panel-body > div')) p.classList.toggle('on', p.dataset.pane === tab);
    const panel = $('#panel');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    if (tab === 'display') renderDisplayPrefs();
    if (tab === 'toc') {
      const cur = $('#tocList button.current');
      const body = $('.panel-body');
      if (cur) body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2);
    }
  }

  function closePanel() {
    const panel = $('#panel');
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }

  function renderToc() {
    const list = $('#tocList');
    list.replaceChildren();
    if (!R.toc.length) {
      list.append(h('li', { class: 'hint', text: 'This book has no table of contents.' }));
      return;
    }
    for (const it of R.toc) {
      list.append(h('li', null, h('button', {
        style: `padding-left:${0.6 + it.depth * 1.1}rem`,
        'data-idx': String(it.idx),
        text: it.label,
        onclick: () => {
          closePanel();
          setBars(false);
          R.rendition.display(it.href).catch(() => toast('Could not open that chapter'));
        },
      })));
    }
  }

  function posText(p) {
    return [p.label, pctText(p.pct), p.at ? relTime(p.at) : ''].filter(Boolean).join(' · ');
  }

  function markSub(m) {
    const name = m.name || '';
    const pct = pctText(m.pct);
    return [name.includes(m.label) ? '' : m.label, pct && !name.includes(pct) ? pct : '', relTime(m.c || m.at)]
      .filter(Boolean).join(' · ');
  }

  function renderMarks() {
    const list = $('#markList');
    if (!list) return;
    list.replaceChildren();
    const marks = R.doc ? liveMarks(R.doc) : [];
    if (!marks.length) {
      list.append(h('li', { class: 'none', text: 'No bookmarks yet. Bookmark a page to come back to it later.' }));
    }
    for (const m of marks) {
      list.append(h('li', null,
        h('button', {
          class: 'go',
          onclick: () => {
            closePanel();
            setBars(false);
            R.rendition.display(m.cfi).catch(() => toast('Could not open that bookmark'));
          },
        }, h('strong', { text: m.name || 'Bookmark' }), h('span', { text: markSub(m) })),
        h('button', { class: 'icon-btn small', 'aria-label': 'Rename bookmark', onclick: () => renameMark(m) }, icon('edit')),
        h('button', { class: 'icon-btn small', 'aria-label': 'Delete bookmark', onclick: () => deleteMark(m) }, icon('trash'))));
    }
    $('#btnMark').classList.toggle('active', marksHere().length > 0);
  }

  async function toggleBookmarkHere() {
    if (!R.loc) return;
    const existing = marksHere()[0];
    if (existing) {
      await deleteMark(existing, true);
      return;
    }
    await addBookmark();
  }

  async function addBookmark() {
    if (!R.loc || !R.name) return;
    const live = liveMarks(R.doc);
    if (live.length >= MAX_MARKS) return toast(`A book can have up to ${MAX_MARKS} bookmarks`);
    if (marksHere().length) return toast('This page is already bookmarked');
    const now = Date.now();
    const pct = currentPct();
    const label = chapterLabel(R.loc.start.index);
    const mark = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 8),
      name: [label || 'Bookmark', pctText(pct)].filter(Boolean).join(' · ').slice(0, 80),
      cfi: R.loc.start.cfi,
      pct,
      label,
      at: now,
      c: now,
    };
    const trial = normalizeDoc({ v: 1, last: R.doc.last, marks: [...R.doc.marks, mark] });
    if (JSON.stringify(trial).length > MAX_DOC_BYTES) return toast('Too many bookmarks for this book - delete some first');
    await changeDoc(R.name, d => { d.marks.push(mark); });
    renderMarks();
    toast('Bookmark added');
    scheduleSync(R.name, MARK_SYNC_MS);
  }

  async function renameMark(m) {
    const name = await promptDialog('Bookmark name', m.name || '');
    if (name === null || !R.name) return;
    const clean = name.trim().slice(0, 80) || m.name;
    await changeDoc(R.name, d => {
      const t = d.marks.find(x => x.id === m.id);
      if (t && !t.del) { t.name = clean; t.at = Date.now(); }
    });
    renderMarks();
    scheduleSync(R.name, MARK_SYNC_MS);
  }

  async function deleteMark(m, quiet) {
    if (!R.name) return;
    await changeDoc(R.name, d => {
      const i = d.marks.findIndex(x => x.id === m.id);
      const tomb = { id: m.id, del: true, at: Date.now(), c: m.c || 0 };
      if (i >= 0) d.marks[i] = tomb; else d.marks.push(tomb);
    });
    renderMarks();
    if (quiet) toast('Bookmark removed');
    scheduleSync(R.name, MARK_SYNC_MS);
  }

  function resumeDialog(doc) {
    return new Promise(resolve => {
      const dlg = $('#dlgResume');
      const list = $('#resumeList');
      list.replaceChildren();
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const add = (title, sub, cfi, primary) => list.append(h('button', {
        class: 'choice' + (primary ? ' primary' : ''),
        onclick: () => { finish(cfi); dlg.close(); },
      }, h('strong', { text: title }), sub ? h('span', { text: sub }) : null));
      if (doc.last) add('Continue reading', posText(doc.last), doc.last.cfi, true);
      else add('Start from the beginning', '', null, true);
      for (const m of liveMarks(doc)) add(m.name || 'Bookmark', markSub(m), m.cfi, false);
      dlg.addEventListener('close', () => finish(undefined), { once: true });
      dlg.showModal();
    });
  }

  // ---------------- Display preferences ----------------
  // One style element per page that is rewritten on change; epub.js themes stack up instead.
  function readerCss() {
    const t = THEMES[prefs.theme] || THEMES.light;
    let css = `html, body { color: ${t.fg} !important; background: ${t.bg} !important; }`;
    if (prefs.theme !== 'light') {
      css += ' body * { color: inherit !important; background-color: transparent !important; }';
    }
    css += ` a, a * { color: ${t.link} !important; }`;
    if (prefs.font !== 'publisher' && FONT_STACK[prefs.font]) {
      css += ` body, body *:not(code):not(pre):not(kbd):not(samp) { font-family: ${FONT_STACK[prefs.font]} !important; }`;
    }
    return css;
  }

  function styleContents(contents) {
    const doc = contents && contents.document;
    if (!doc || !doc.head) return;
    let el = doc.getElementById('onebook-style');
    if (!el) {
      el = doc.createElement('style');
      el.id = 'onebook-style';
      doc.head.appendChild(el);
    }
    el.textContent = readerCss();
  }

  function applyPrefs() {
    const t = THEMES[prefs.theme] || THEMES.light;
    document.documentElement.dataset.readerTheme = prefs.theme;
    document.documentElement.style.setProperty('--reader-max', prefs.spread ? '1280px' : '760px');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', R.book ? t.bg : '#1f2a37');
    const r = R.rendition;
    if (!r) return;
    r.themes.fontSize(prefs.fontSize + '%');
    for (const c of r.getContents()) styleContents(c);
  }

  function renderDisplayPrefs() {
    for (const b of document.querySelectorAll('#segTheme button')) b.classList.toggle('on', b.dataset.v === prefs.theme);
    for (const b of document.querySelectorAll('#segFont button')) b.classList.toggle('on', b.dataset.v === prefs.font);
    $('#fontVal').textContent = prefs.fontSize + '%';
    $('#chkSpread').checked = prefs.spread;
  }

  function setPref(k, v) {
    prefs[k] = v;
    savePrefs();
    applyPrefs();
    renderDisplayPrefs();
  }

  // ---------------- Views and navigation ----------------
  function showView(which) {
    $('#library').classList.toggle('hidden', which !== 'library');
    $('#reader').classList.toggle('hidden', which !== 'reader');
  }

  function closeReader(fromPopState) {
    const name = R.name;
    if (name && R.dirty && state.online) flushSync(name);
    try { if (R.rendition) R.rendition.destroy(); } catch { /* already gone */ }
    try { if (R.book) R.book.destroy(); } catch { /* already gone */ }
    Object.assign(R, { name: null, book: null, rendition: null, loc: null, toc: [], doc: null, dirty: false, touch: null });
    $('#viewer').replaceChildren();
    closePanel();
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    showView('library');
    applyPrefs();
    if (R.pushed) {
      R.pushed = false;
      if (!fromPopState) history.back();
    }
    renderLibrary();
  }

  // ---------------- Dialog helpers ----------------
  function confirmDialog(text, okText) {
    return new Promise(resolve => {
      const dlg = $('#dlgConfirm');
      $('#confirmText').textContent = text;
      const ok = $('#confirmOk');
      ok.textContent = okText || 'OK';
      let result = false;
      ok.onclick = () => { result = true; dlg.close(); };
      $('#confirmCancel').onclick = () => dlg.close();
      dlg.addEventListener('close', () => resolve(result), { once: true });
      dlg.showModal();
    });
  }

  function promptDialog(label, value) {
    return new Promise(resolve => {
      const dlg = $('#dlgPrompt');
      const input = $('#promptInput');
      $('#promptLabel').textContent = label;
      input.value = value;
      let result = null;
      $('#promptForm').onsubmit = e => { e.preventDefault(); result = input.value; dlg.close(); };
      $('#promptCancel').onclick = () => dlg.close();
      dlg.addEventListener('close', () => resolve(result), { once: true });
      dlg.showModal();
      input.select();
    });
  }

  // ---------------- Settings dialog ----------------
  function openSettings() {
    $('#setUrl').value = cfg.url;
    $('#setToken').value = cfg.token;
    $('#setToken').type = 'password';
    $('#setResult').textContent = '';
    $('#setResult').className = 'result';
    $('#deviceLog').classList.add('hidden');
    renderDeviceInfo();
    renderLocalUsage();
    $('#dlgSettings').showModal();
  }

  function readSettingsForm() {
    let url;
    try {
      url = normalizeUrl($('#setUrl').value);
    } catch {
      throw new Error('That server address is not valid');
    }
    if (!url) throw new Error('Enter your server address');
    const token = $('#setToken').value.trim();
    if (!token) throw new Error('Enter your access token');
    return { url, token };
  }

  function setResult(text, cls) {
    const r = $('#setResult');
    r.textContent = text;
    r.className = 'result' + (cls ? ' ' + cls : '');
  }

  async function testSettings() {
    let conf;
    try { conf = readSettingsForm(); } catch (e) { setResult(e.message, 'err'); return null; }
    setResult('Testing...');
    try {
      const st = await (await api('GET', '/api/status', {}, conf)).json();
      const sd = st.sd && st.sd.ok ? `${fmtBytes(st.sd.used)} of ${fmtBytes(st.sd.total)} used` : 'SD card not available';
      setResult(`Connected to OneBook ${st.fw || ''} · ${sd}`, 'ok');
      return conf;
    } catch (e) {
      setResult(errText(e), 'err');
      return null;
    }
  }

  function saveSettings() {
    let conf;
    try { conf = readSettingsForm(); } catch (e) { setResult(e.message, 'err'); return; }
    const changed = conf.url !== cfg.url;
    cfg = conf;
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    if (changed) {
      state.books = [];
      state.meta.clear();
      state.local.clear();
    }
    $('#dlgSettings').close();
    refreshLibrary();
  }

  function renderDeviceInfo() {
    const st = state.status;
    const sec = $('#deviceSection');
    if (!st || !state.online) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    const dl = $('#deviceInfo');
    dl.replaceChildren();
    const row = (k, v) => { if (v) dl.append(h('dt', { text: k }), h('dd', { text: v })); };
    row('Firmware', st.fw);
    row('Up for', typeof st.uptime === 'number' ? fmtUptime(st.uptime) : '');
    row('Wi-Fi signal', typeof st.rssi === 'number' ? `${st.rssi} dBm` : '');
    row('Storage', st.sd && st.sd.ok ? `${fmtBytes(st.sd.used)} of ${fmtBytes(st.sd.total)} used` : 'SD card not available');
    row('Books', String(state.books.length));
  }

  async function renderLocalUsage() {
    const el = $('#localUsage');
    let text = `${state.local.size} book${state.local.size === 1 ? '' : 's'} downloaded for offline reading.`;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        if (est.usage) text += ` This site uses ${fmtBytes(est.usage)} of browser storage.`;
      }
    } catch { /* estimate not supported */ }
    el.textContent = text;
  }

  async function clearDownloads() {
    if (!await confirmDialog('Remove all downloaded books from this browser? Your books stay on OneBook.', 'Remove')) return;
    const prefix = cfg.url + '|';
    for (const s of ['books', 'locations']) {
      const keys = await idbKeys(s);
      for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix)) await idbDel(s, k);
    }
    state.local.clear();
    renderLocalUsage();
    renderLibrary();
    toast('Downloads removed');
  }

  async function showLog() {
    const pre = $('#deviceLog');
    pre.classList.remove('hidden');
    pre.textContent = 'Loading...';
    try {
      pre.textContent = (await (await api('GET', '/api/log')).text()) || '(empty)';
    } catch (e) {
      pre.textContent = errText(e);
    }
  }

  // ---------------- Wiring ----------------
  function wire() {
    $('#btnRefresh').onclick = refreshLibrary;
    $('#btnUpload').onclick = openUpload;
    $('#btnSettings').onclick = openSettings;
    $('#search').addEventListener('input', e => { state.query = e.target.value; renderLibrary(); });

    $('#btnTest').onclick = testSettings;
    $('#btnSave').onclick = saveSettings;
    $('#btnShowToken').onclick = () => {
      const t = $('#setToken');
      t.type = t.type === 'password' ? 'text' : 'password';
    };
    $('#btnLog').onclick = showLog;
    $('#btnClearLocal').onclick = clearDownloads;

    const drop = $('#dropZone');
    const input = $('#fileInput');
    input.addEventListener('change', () => { queueFiles([...input.files]); input.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files.length) queueFiles([...e.dataTransfer.files]);
    });

    $('#busyCancel').onclick = () => { if (busyCancel) busyCancel(); };

    $('#btnBack').onclick = () => closeReader(false);
    $('#btnPrev').onclick = prev;
    $('#btnNext').onclick = next;
    $('#btnToc').onclick = () => openPanel('toc');
    $('#btnMarks').onclick = () => openPanel('marks');
    $('#btnDisplay').onclick = () => openPanel('display');
    $('#btnMark').onclick = toggleBookmarkHere;
    $('#btnAddMark').onclick = addBookmark;
    $('#btnPanelClose').onclick = closePanel;
    for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => openPanel(b.dataset.tab);
    for (const b of document.querySelectorAll('#segTheme button')) b.onclick = () => setPref('theme', b.dataset.v);
    for (const b of document.querySelectorAll('#segFont button')) b.onclick = () => setPref('font', b.dataset.v);
    $('#fontDown').onclick = () => setPref('fontSize', Math.max(70, prefs.fontSize - 10));
    $('#fontUp').onclick = () => setPref('fontSize', Math.min(220, prefs.fontSize + 10));
    $('#chkSpread').onchange = e => {
      setPref('spread', e.target.checked);
      if (R.rendition) {
        R.rendition.spread(prefs.spread ? 'auto' : 'none', 900);
        requestAnimationFrame(() => { try { R.rendition.resize(); } catch { /* not displayed yet */ } });
      }
    };

    document.addEventListener('click', e => {
      const c = e.target.closest('[data-close]');
      if (c) c.closest('dialog').close();
    });
    for (const d of document.querySelectorAll('dialog')) {
      d.addEventListener('click', e => { if (e.target === d) d.close(); });
    }

    document.addEventListener('keyup', e => {
      if (!$('#reader').classList.contains('hidden')) onKey(e);
    });

    window.addEventListener('popstate', () => {
      if (R.pushed || R.book) {
        R.pushed = false;
        closeReader(true);
      }
    });

    window.addEventListener('online', refreshLibrary);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (R.name && R.dirty && state.online) flushSync(R.name);
      } else if (!R.book && Date.now() - state.lastRefresh > 60000) {
        refreshLibrary();
      }
    });
    // Last chance on tab close; the regular sync covers everything else.
    window.addEventListener('pagehide', () => {
      if (R.name && R.dirty && R.doc && cfg.url) {
        api('PUT', '/api/bookmarks/' + enc(R.name), {
          body: JSON.stringify(R.doc),
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
        }).catch(() => {});
      }
    });
  }

  function start() {
    if (typeof ePub !== 'function') {
      document.body.textContent = 'OneBook could not load its reader library. Please reload the page.';
      return;
    }
    wire();
    applyPrefs();
    renderDisplayPrefs();
    refreshLibrary();
    if (!cfg.url) openSettings();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  start();
})();
