/*
 * Transcribe API — dashboard SPA.
 *
 * Vanilla JS, no build step, no dependencies. The page runs under a strict CSP
 * (script-src/style-src 'self'), so there are no inline handlers or style attributes:
 * every element is created with h() and all server data goes in via textContent.
 *
 * Routes (hash based):
 *   #/login  #/register  #/projects  #/projects/<id>/<tab>  #/transcriptions/<id>
 *   #/account  #/admin/users
 * API: relative to the page (served at the base path with a trailing slash), see SPEC §9.
 */
(function () {
  'use strict';

  // ================================================================ constants

  const APP_NAME = 'Transcribe API';
  const API = 'api/dash/';
  const POLL_MS = 3000;
  const PAGE_SIZE = 20;

  const TABS = [
    { id: 'transcriptions', label: 'Transcriptions', icon: 'list' },
    { id: 'keys', label: 'API keys', icon: 'key' },
    { id: 'members', label: 'Members', icon: 'users' },
    { id: 'settings', label: 'Settings', icon: 'sliders' },
    { id: 'docs', label: 'Docs', icon: 'book' },
  ];

  const LANGUAGES = [
    ['en', 'English'], ['ur', 'Urdu'], ['hi', 'Hindi'], ['ar', 'Arabic'], ['es', 'Spanish'],
    ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'],
    ['ru', 'Russian'], ['tr', 'Turkish'], ['fa', 'Persian'], ['bn', 'Bengali'], ['pa', 'Punjabi'],
    ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['id', 'Indonesian'], ['ms', 'Malay'],
    ['pl', 'Polish'], ['uk', 'Ukrainian'], ['sv', 'Swedish'], ['vi', 'Vietnamese'], ['th', 'Thai'],
    ['ta', 'Tamil'],
  ];
  const LANG_NAMES = Object.fromEntries(LANGUAGES);

  const ENGINES = ['cloud', 'worker'];
  const ENGINE_LABELS = { cloud: 'Cloud', worker: 'PC worker' };
  const ENGINE_HINTS = { cloud: 'fast', worker: 'local Whisper' };
  const STATUSES = ['queued', 'processing', 'completed', 'failed'];
  const STATUS_LABELS = { queued: 'Queued', processing: 'Processing', completed: 'Completed', failed: 'Failed' };
  const FORMATS = ['txt', 'srt', 'vtt', 'json'];

  // Stroke icons (24×24, Feather-style paths).
  const ICONS = {
    wave: 'M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4',
    plus: 'M12 5v14M5 12h14',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    file: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
    refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    rotate: 'M1 4v6h6M3.51 15a9 9 0 1 0 2.13-9.36L1 10',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22',
    x: 'M18 6L6 18M6 6l12 12',
    check: 'M20 6L9 17l-5-5',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
    alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
    chevronLeft: 'M15 18l-6-6 6-6',
    chevronRight: 'M9 18l6-6-6-6',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  };

  // ================================================================ state

  const state = { user: null, csrf: '', config: null };
  let current = null;  // active view context (see beginView)
  let shell = null;    // project page header + tabs, kept while switching tabs of one project
  let booted = false;

  const $view = document.getElementById('view');
  const $top = document.getElementById('topbar');
  const $toasts = document.getElementById('toasts');

  // ================================================================ DOM helpers

  // Properties that must be set as DOM properties rather than attributes.
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'required', 'multiple', 'indeterminate']);

  /** h('tag', {attrs/props/onEvent}, ...children). Strings always become text nodes. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (PROPS.has(k)) el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    return append(el, kids);
  }

  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls ? 'icon ' + cls : 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.info);
    svg.append(path);
    return svg;
  }

  let uidCounter = 0;
  const uid = (prefix) => (prefix || 'el') + '-' + (++uidCounter);
  const enc = encodeURIComponent;
  const cfg = () => state.config || {};

  function qs(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) q.set(k, v);
    return q.toString();
  }

  function loadPref(key, fallback) {
    try { return localStorage.getItem('tapi.' + key) || fallback; } catch (e) { return fallback; }
  }
  function savePref(key, value) {
    try { localStorage.setItem('tapi.' + key, value); } catch (e) { /* storage unavailable: ignore */ }
  }

  // ================================================================ formatting

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  function relTime(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    if (isNaN(t)) return '—';
    const diff = (t - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45) return 'just now';
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
    const d = new Date(t);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function absTime(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    return isNaN(t) ? '' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function timeEl(iso) {
    return iso ? h('time', { datetime: iso, title: absTime(iso) }, relTime(iso)) : '—';
  }

  /** 819.4 → "13 min 39 s" */
  function fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return '—';
    sec = Math.round(Number(sec));
    if (sec < 60) return sec + ' s';
    const hrs = Math.floor(sec / 3600), min = Math.floor(sec / 60) % 60, s = sec % 60;
    if (hrs) return min ? `${hrs} h ${min} min` : `${hrs} h`;
    return s ? `${min} min ${s} s` : `${min} min`;
  }

  /** Player clock: 75 → "01:15", 3723 → "1:02:03" (same as transcriber.html). */
  function clock(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const hrs = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return (hrs ? hrs + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(sec).padStart(2, '0');
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    n = Number(n);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
  }

  function langLabel(code, autoLabel) {
    if (!code) return autoLabel || 'Auto-detect';
    if (LANG_NAMES[code]) return LANG_NAMES[code];
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
      if (name && name !== code) return name;
    } catch (e) { /* unknown code */ }
    return code.toUpperCase();
  }

  const engineLabel = (e) => ENGINE_LABELS[e] || e || '—';
  const isActive = (t) => t.status === 'queued' || t.status === 'processing';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const baseName = (name) => String(name || 'transcript').replace(/\.[^.]+$/, '') || 'transcript';

  /** First letters of the first and last word ("E2E Project (renamed)" -> "ER"); punctuation is ignored. */
  function initials(name) {
    const parts = String(name || '').replace(/@.*/, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const first = (word) => Array.from(word)[0]; // whole code point, not half a surrogate pair
    if (!parts.length) return '?';
    return (first(parts[0]) + (parts.length > 1 ? first(parts[parts.length - 1]) : '')).toUpperCase();
  }

  function avatar(name, size) {
    let hash = 0;
    for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return h('span', { class: ['avatar', size, 'av-' + (hash % 5)], 'aria-hidden': 'true' }, initials(name));
  }

  /** Public base URL of this install, without trailing slash. */
  function baseUrl() {
    const configured = cfg().base_url;
    const fallback = location.origin + location.pathname.replace(/index\.html$/, '');
    return String(configured || fallback).replace(/\/+$/, '');
  }

  function allowedExts() {
    const list = cfg().allowed_extensions || ['mp3'];
    return list.map((e) => String(e).toLowerCase().replace(/^\./, '')).filter(Boolean);
  }

  function enginesEnabled() {
    const e = cfg().engines || { cloud: true, worker: true };
    return ENGINES.filter((name) => e[name]);
  }

  const isOwner = (p) => p.role === 'owner' || !!(state.user && state.user.is_admin);

  // ================================================================ API client

  class ApiError extends Error {
    constructor(status, code, message, data) {
      super(message);
      this.status = status;
      this.code = code;
      this.data = data || null;
    }
  }

  function parseJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function errorFrom(status, data) {
    const e = data && data.error;
    let message = e && e.message;
    if (!message) {
      if (!status) message = 'Could not reach the server. Check your connection and try again.';
      else if (status === 413) message = 'The file is too large for the server.';
      else if (status >= 500) message = 'The server ran into a problem. Please try again.';
      else message = `Request failed (HTTP ${status}).`;
    }
    return new ApiError(status, (e && e.code) || (status ? 'http_' + status : 'network_error'), message, data);
  }

  /**
   * JSON request to the dashboard API. Non-GET requests carry the CSRF token; a stale
   * token (csrf_failed) is refreshed once and the request retried. 401 → login view
   * unless opts.allow401.
   */
  async function api(path, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf || '';
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(API + path, { method, headers, body, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      throw errorFrom(0, null);
    }
    const data = parseJson(await res.text().catch(() => ''));
    if (res.ok) return data || {};
    const err = errorFrom(res.status, data);
    if (err.code === 'csrf_failed' && method !== 'GET' && !opts.retried && await refreshSession()) {
      return api(path, Object.assign({}, opts, { retried: true }));
    }
    if (res.status === 401 && !opts.allow401) onUnauthorized();
    throw err;
  }

  /** Multipart upload with progress (XMLHttpRequest, because fetch has no upload progress). */
  function uploadTranscription(projectId, file, fields, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', API + 'projects/' + enc(projectId) + '/transcriptions');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-CSRF-Token', state.csrf || '');
      xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); });
      xhr.addEventListener('load', () => {
        const data = parseJson(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data || {});
        else reject(errorFrom(xhr.status, data));
      });
      xhr.addEventListener('error', () => reject(errorFrom(0, null)));
      xhr.addEventListener('abort', () => reject(new ApiError(0, 'aborted', 'Upload cancelled.')));
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') form.append(k, v);
      form.append('file', file, file.name);
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  }

  function applySession(data) {
    if (!data) return;
    if (data.user) state.user = data.user;
    if (data.csrf_token) state.csrf = data.csrf_token;
    if (data.config) state.config = data.config;
  }

  /** GET /me. Resolves whether or not a session exists; throws only on network/server errors. */
  async function loadMe() {
    try {
      applySession(await api('me', { allow401: true }));
    } catch (e) {
      if (e.status !== 401) throw e;
      state.user = null;
      state.csrf = '';
      // Optional: a backend may include public config in the 401 body (e.g. allow_registration).
      if (e.data && e.data.config) state.config = e.data.config;
    }
  }

  async function refreshSession() {
    try { await loadMe(); return !!state.user; } catch (e) { return false; }
  }

  function onUnauthorized() {
    const hadUser = !!state.user;
    state.user = null;
    state.csrf = '';
    shell = null;
    const { path } = parseHash();
    if (path === '/login' || path === '/register') return;
    if (hadUser) toast('Your session has ended. Please sign in again.', 'info');
    navigate('/login?next=' + enc(path), true);
  }

  // ================================================================ background uploads

  // Uploads live outside any view so they keep going while the user moves around the app.
  const uploads = {
    items: [],
    running: false,
    listeners: { change: new Set(), done: new Set() },

    on(event, fn) {
      this.listeners[event].add(fn);
      return () => this.listeners[event].delete(fn);
    },
    emit(event, item) {
      for (const fn of this.listeners[event]) {
        try { fn(item); } catch (e) { console.error(e); }
      }
    },
    busy() {
      return this.items.some((i) => i.status === 'waiting' || i.status === 'uploading');
    },
    add(projectId, files, fields) {
      for (const file of files) {
        this.items.push({ id: uid('up'), projectId, file, fields: Object.assign({}, fields), status: 'waiting', loaded: 0, total: file.size, error: null, result: null, req: null });
      }
      this.emit('change');
      this.pump();
    },
    cancel(item) {
      if (item.status === 'uploading' && item.req) item.req.abort();
      else if (item.status === 'waiting') { item.status = 'cancelled'; this.emit('change'); }
    },
    cancelAll() {
      this.items.forEach((i) => this.cancel(i));
    },
    retry(item) {
      Object.assign(item, { status: 'waiting', error: null, loaded: 0 });
      this.emit('change');
      this.pump();
    },
    dismiss(item) {
      this.items = this.items.filter((i) => i !== item);
      this.emit('change');
    },
    clearFinished(projectId) {
      this.items = this.items.filter((i) => i.projectId !== projectId || i.status === 'waiting' || i.status === 'uploading');
      this.emit('change');
    },
    async pump() {
      if (this.running) return;
      this.running = true;
      let next;
      while ((next = this.items.find((i) => i.status === 'waiting'))) await this.run(next);
      this.running = false;
    },
    async run(item) {
      for (let attempt = 0; ; attempt++) {
        Object.assign(item, { status: 'uploading', loaded: 0 });
        this.emit('change');
        item.req = uploadTranscription(item.projectId, item.file, item.fields, (loaded, total) => {
          item.loaded = loaded;
          item.total = total;
          this.emit('change');
        });
        try {
          item.result = await item.req.promise;
          item.status = 'done';
          const finished = item.result.status === 'completed';
          toast(`${item.file.name} uploaded — ${finished ? 'transcript ready' : 'queued for transcription'}.`, 'success');
          this.emit('done', item);
        } catch (e) {
          if (e.code === 'csrf_failed' && attempt === 0 && await refreshSession()) continue;
          item.status = e.code === 'aborted' ? 'cancelled' : 'error';
          item.error = e.message;
          if (e.status === 401) onUnauthorized();
          else if (item.status === 'error') toast(`${item.file.name}: ${e.message}`, 'error');
        }
        break;
      }
      item.req = null;
      this.emit('change');
    },
  };

  window.addEventListener('beforeunload', (e) => {
    if (uploads.busy()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Dropping a file outside the drop zone must not navigate away from the app.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ================================================================ UI primitives

  function toast(message, type, ms) {
    type = type || 'info';
    const close = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    };
    const el = h('div', { class: ['toast', 'toast-' + type], role: type === 'error' ? 'alert' : 'status' },
      icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info'),
      h('span', { class: 'toast-msg' }, message),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss notification', onclick: close }, icon('x')));
    // A modal <dialog> sits in the browser's top layer; host the toasts inside it so they stay visible.
    const host = document.querySelector('dialog[open]') || document.body;
    if ($toasts.parentNode !== host) host.append($toasts);
    $toasts.append(el);
    while ($toasts.children.length > 4) $toasts.firstElementChild.remove();
    setTimeout(close, ms || (type === 'error' ? 7000 : 3500));
  }

  function toastError(err) {
    if (!err || err.code === 'aborted' || err.status === 401) return;
    if (!(err instanceof ApiError)) console.error(err);
    toast(err.message || 'Something went wrong.', 'error');
  }

  /** Disable a button and show a spinner while fn runs. */
  async function withBusy(btn, fn) {
    if (btn.disabled) return undefined;
    btn.disabled = true;
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
    }
  }

  async function copyText(text, label) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else legacyCopy(text);
      toast(label || 'Copied to clipboard', 'success', 2200);
    } catch (e) {
      try {
        legacyCopy(text);
        toast(label || 'Copied to clipboard', 'success', 2200);
      } catch (e2) {
        toast('Could not copy automatically — select the text and copy it manually.', 'error');
      }
    }
  }

  function legacyCopy(text) {
    // Inside a modal dialog the rest of the page is inert, so the helper must live in the dialog.
    const host = document.querySelector('dialog[open]') || document.body;
    const ta = h('textarea', { class: 'clip-helper', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    host.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy failed');
  }

  function field(label, control, opts) {
    opts = opts || {};
    if (!control.id) control.id = uid('f');
    const kids = [h('label', { for: control.id }, label), control];
    if (opts.hint) {
      const hintId = control.id + '-hint';
      control.setAttribute('aria-describedby', hintId);
      kids.push(h('p', { class: 'hint', id: hintId }, opts.hint));
    }
    return h('div', { class: ['field', opts.class] }, kids);
  }

  const formError = () => h('p', { class: 'form-error', role: 'alert', hidden: true });
  function setError(el, message) { el.textContent = message; el.hidden = false; }
  function clearError(el) { el.textContent = ''; el.hidden = true; }

  function callout(type, title, text) {
    return h('div', { class: ['callout', type], role: type === 'error' ? 'alert' : null },
      icon(type === 'error' || type === 'warn' ? 'alert' : 'info'),
      h('div', null, title && h('strong', null, title), text));
  }

  function statusBadge(t) {
    return h('span', { class: ['badge', 'st-' + t.status] }, STATUS_LABELS[t.status] || t.status || 'Unknown');
  }

  function roleBadge(role) {
    return h('span', { class: ['badge', role === 'owner' && 'accent'] }, role === 'owner' ? 'Owner' : role === 'member' ? 'Member' : (role || 'Admin access'));
  }

  function loadingState(text) {
    return h('div', { class: 'state loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, text || 'Loading…'));
  }

  function skeleton(kind, count) {
    const wrap = h('div', { role: 'status', 'aria-label': 'Loading' });
    for (let i = 0; i < count; i++) wrap.append(h('div', { class: ['skeleton', kind], 'aria-hidden': 'true' }));
    return wrap;
  }

  function emptyState(o) {
    return h('div', { class: 'state' }, icon(o.icon || 'info', 'state-icon'), h('h2', null, o.title), o.text && h('p', null, o.text),
      o.action && h('div', { class: 'state-actions' }, o.action));
  }

  function errorState(err, retry) {
    const notFound = err && err.status === 404;
    const forbidden = err && err.status === 403;
    return h('div', { class: 'state error-state', role: 'alert' },
      icon(notFound ? 'search' : forbidden ? 'lock' : 'alert', 'state-icon'),
      h('h2', null, notFound ? 'Not found' : forbidden ? 'No access' : 'Something went wrong'),
      h('p', null, (err && err.message) || 'Unexpected error.'),
      h('div', { class: 'state-actions' },
        retry && !notFound && !forbidden && h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh'), 'Try again'),
        h('a', { class: 'btn', href: '#/projects' }, 'Go to projects')));
  }

  function codeBlock(code, label) {
    const codeEl = h('code', null, code);
    const block = h('div', { class: 'code' },
      h('div', { class: 'code-head' }, h('span', null, label || 'Example'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => copyText(codeEl.textContent) }, icon('copy'), 'Copy')),
      h('pre', { tabindex: '0' }, codeEl));
    block.setCode = (text) => { codeEl.textContent = text; };
    return block;
  }

  function languageSelect(value, attrs) {
    const sel = h('select', attrs, h('option', { value: '' }, 'Auto-detect'),
      LANGUAGES.map(([code, name]) => h('option', { value: code }, `${name} (${code})`)));
    if (value && !LANG_NAMES[value]) sel.append(h('option', { value }, langLabel(value) + ` (${value})`));
    sel.value = value || '';
    return sel;
  }

  // ---------------------------------------------------------------- dialogs

  function openDialog(title, content, opts) {
    opts = opts || {};
    const titleId = uid('dlg');
    const dlg = h('dialog', { class: ['modal', opts.wide && 'wide'], 'aria-labelledby': titleId },
      h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close dialog', onclick: () => dlg.dismiss() }, icon('x'))),
      content);
    // Buttons call dlg.dismiss() so callers resolve synchronously; the native 'close'
    // event (Esc key) takes the same path. The guard makes it run once.
    let finished = false;
    dlg.dismiss = () => {
      if (finished) return;
      finished = true;
      if (dlg.contains($toasts)) document.body.append($toasts);
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opts.onClose) opts.onClose();
    };
    dlg.addEventListener('close', () => {
      // A non-dismissable dialog closed by Esc (Chrome closes on a repeated Esc even when 'cancel' is
      // prevented) is shown again: only its own buttons (dlg.dismiss) may close it.
      if (opts.dismissable === false && !finished) {
        dlg.showModal();
        return;
      }
      dlg.dismiss();
    });
    if (opts.dismissable === false) {
      // Esc must not throw away content shown only once (e.g. a new API key); use the explicit buttons.
      dlg.addEventListener('cancel', (e) => e.preventDefault());
    } else {
      // Click on the backdrop (outside the dialog box) closes it.
      dlg.addEventListener('mousedown', (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.dismiss();
      });
    }
    document.body.append(dlg);
    dlg.showModal();
    const target = opts.focus || content.querySelector('[autofocus], input:not([type=hidden]), select, textarea');
    if (target) target.focus();
    return dlg;
  }

  function confirmDialog(o) {
    return new Promise((resolve) => {
      let ok = false;
      const yes = h('button', { class: ['btn', o.danger ? 'danger' : 'primary'], type: 'button', onclick: () => { ok = true; dlg.dismiss(); } }, o.confirmLabel || 'Confirm');
      const no = h('button', { class: 'btn', type: 'button', onclick: () => dlg.dismiss() }, 'Cancel');
      const dlg = openDialog(o.title, h('div', null,
        h('div', { class: 'modal-body' }, h('p', null, o.message)),
        h('div', { class: 'modal-actions' }, no, yes)), { onClose: () => resolve(ok), focus: o.danger ? no : yes });
    });
  }

  /** Dialog with a form. onSubmit may throw an ApiError; its message is shown inline. */
  function formDialog(o) {
    const err = formError();
    const submit = h('button', { class: ['btn', o.danger ? 'danger' : 'primary'], type: 'submit' }, o.submitLabel || 'Save');
    const form = h('form', {
      novalidate: o.novalidate,
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(submit, async () => {
          clearError(err);
          try {
            await o.onSubmit();
            dlg.dismiss();
          } catch (ex) {
            if (ex.status === 401) { dlg.dismiss(); return; }
            setError(err, ex.message);
          }
        });
      },
    },
    h('div', { class: 'modal-body stack' }, o.body, err),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.dismiss() }, 'Cancel'), submit));
    const dlg = openDialog(o.title, form, { wide: o.wide });
    return dlg;
  }

  // ================================================================ router & views

  const ROUTES = [
    { re: /^\/login$/, view: viewLogin, public: true, title: 'Sign in' },
    { re: /^\/register$/, view: viewRegister, public: true, title: 'Create account' },
    { re: /^\/projects$/, view: viewProjects, title: 'Projects' },
    { re: /^\/projects\/([^/]+)(?:\/([a-z]+))?$/, view: viewProject, title: 'Project' },
    { re: /^\/transcriptions\/([^/]+)$/, view: viewTranscription, title: 'Transcript' },
    { re: /^\/account$/, view: viewAccount, title: 'Account' },
    { re: /^\/admin\/users$/, view: viewAdminUsers, admin: true, title: 'Users' },
  ];

  function parseHash() {
    const raw = location.hash.replace(/^#/, '');
    const i = raw.indexOf('?');
    return { path: (i >= 0 ? raw.slice(0, i) : raw) || '/', query: new URLSearchParams(i >= 0 ? raw.slice(i + 1) : '') };
  }

  function navigate(path, replace) {
    if (replace) {
      history.replaceState(null, '', '#' + path);
      onRoute();
    } else if (location.hash === '#' + path) {
      onRoute();
    } else {
      location.hash = path;
    }
  }

  /** Each rendered view gets a context; timers and listeners registered on it die with the view. */
  function beginView() {
    if (current) {
      current.alive = false;
      for (const fn of current.cleanups) {
        try { fn(); } catch (e) { console.error(e); }
      }
    }
    const ctx = {
      alive: true,
      cleanups: [],
      focusPending: booted,
      onCleanup(fn) { this.cleanups.push(fn); },
      timeout(fn, ms) {
        const id = setTimeout(() => { if (ctx.alive) fn(); }, ms);
        this.cleanups.push(() => clearTimeout(id));
        return id;
      },
    };
    current = ctx;
    return ctx;
  }

  /** Replace the main view content; moves focus to the new heading after navigation. */
  function setView(...nodes) {
    $view.replaceChildren(...nodes.flat());
    if (current && current.focusPending) {
      const heading = $view.querySelector('h1');
      if (heading) {
        current.focusPending = false;
        window.scrollTo(0, 0);
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
  }

  async function onRoute() {
    const { path, query } = parseHash();
    const route = ROUTES.find((r) => r.re.test(path));
    if (!route) return navigate(state.user ? '/projects' : '/login', true);
    if (!route.public && !state.user) return navigate('/login' + (path !== '/' ? '?next=' + enc(path) : ''), true);
    if (route.public && state.user) return navigate('/projects', true);
    if (route.admin && !state.user.is_admin) {
      toast('That page is for administrators only.', 'error');
      return navigate('/projects', true);
    }

    const ctx = beginView();
    document.title = route.title + ' · ' + APP_NAME;
    renderTopbar(path);
    let params = path.match(route.re).slice(1);
    try {
      params = params.map((p) => (p == null ? p : decodeURIComponent(p)));
    } catch (e) { /* malformed escape: use raw */ }
    try {
      await route.view(ctx, params, query);
    } catch (err) {
      if (!ctx.alive || err.status === 401) return;
      if (!(err instanceof ApiError)) console.error(err);
      shell = null;
      setView(errorState(err, () => onRoute()));
    }
  }

  function renderTopbar(path) {
    if (!state.user) {
      $top.hidden = true;
      $top.replaceChildren();
      return;
    }
    const u = state.user;
    const link = (href, label, iconName, active) =>
      h('a', { href, class: 'nav-link', 'aria-current': active ? 'page' : null }, icon(iconName), h('span', { class: 'nav-label' }, label));
    $top.hidden = false;
    $top.replaceChildren(h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '#/projects' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, icon('wave')), h('span', { class: 'brand-name' }, APP_NAME)),
      h('nav', { class: 'nav', 'aria-label': 'Main' },
        link('#/projects', 'Projects', 'folder', /^\/(projects|transcriptions)/.test(path)),
        u.is_admin && link('#/admin/users', 'Users', 'shield', path.startsWith('/admin')),
        h('a', { href: '#/account', class: 'nav-link account', 'aria-current': path === '/account' ? 'page' : null, title: u.email },
          avatar(u.name || u.email, 'sm'), h('span', { class: 'nav-label' }, (u.name || u.email || 'Account').split(' ')[0])))));
  }

  function pageHead(title, subtitle, actions) {
    return h('div', { class: 'page-head' },
      h('div', { class: 'page-title' }, h('h1', null, title), subtitle && h('p', { class: 'muted' }, subtitle)),
      actions && h('div', { class: 'page-actions' }, actions));
  }

  const safeNext = (n) => (n && /^\/[\w\-/]*$/.test(n) && !/^\/(login|register)/.test(n) ? n : null);

  // ================================================================ view: sign in / register

  function authLayout(title, lead, ...content) {
    return h('div', { class: 'auth' },
      h('div', { class: 'card auth-card' },
        h('div', { class: 'auth-brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, icon('wave')), APP_NAME),
        h('h1', null, title),
        h('p', { class: 'muted lead' }, lead),
        content));
  }

  async function afterSignIn(data, next) {
    applySession(data);
    await loadMe().catch(() => {}); // fetches config (engines, limits, base URL)
    navigate(next || '/projects', true);
  }

  function viewLogin(ctx, _params, query) {
    const next = safeNext(query.get('next'));
    const email = h('input', { type: 'email', autocomplete: 'username', required: true, spellcheck: 'false' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const err = formError();
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');
    const form = h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(submit, async () => {
          clearError(err);
          try {
            const data = await api('login', { method: 'POST', body: { email: email.value.trim(), password: pass.value }, allow401: true });
            await afterSignIn(data, next);
          } catch (ex) {
            setError(err, ex.status === 401 && ex.code === 'unauthorized' && !ex.data ? 'Wrong email or password.' : ex.message);
            pass.select();
          }
        });
      },
    }, field('Email', email), field('Password', pass), err, submit);

    setView(authLayout('Sign in', 'Manage projects, API keys and transcripts.', form,
      cfg().allow_registration && h('p', { class: 'auth-foot muted' }, 'New here? ', h('a', { href: '#/register' }, 'Create an account'))));
    email.focus();
  }

  function viewRegister() {
    if (state.config && !cfg().allow_registration) {
      setView(authLayout('Create account', 'Registration is turned off on this server.',
        callout('info', null, 'Ask an administrator to create an account for you.'),
        h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, 'Back to sign in'))));
      return;
    }
    const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '190' });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true, spellcheck: 'false' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    const err = formError();
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Create account');
    const form = h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        if (pass.value !== pass2.value) return setError(err, 'The passwords do not match.');
        withBusy(submit, async () => {
          clearError(err);
          try {
            const data = await api('register', { method: 'POST', body: { name: name.value.trim(), email: email.value.trim(), password: pass.value }, allow401: true });
            toast('Welcome! Your account is ready.', 'success');
            await afterSignIn(data);
          } catch (ex) {
            setError(err, ex.message);
          }
        });
      },
    },
    field('Name', name), field('Email', email),
    field('Password', pass, { hint: 'At least 8 characters.' }), field('Confirm password', pass2), err, submit);

    setView(authLayout('Create account', 'Start transcribing in a minute.', form,
      h('p', { class: 'auth-foot muted' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in'))));
    name.focus();
  }

  // ================================================================ view: projects

  async function viewProjects(ctx) {
    const list = skeleton('tile', 3);
    list.className = 'grid';
    const newBtn = h('button', { class: 'btn primary', type: 'button', onclick: createProjectDialog }, icon('plus'), 'New project');
    setView(pageHead('Projects', 'Each project has its own API keys, members, webhook and transcripts.', newBtn), list);

    const { data } = await api('projects');
    if (!ctx.alive) return;
    if (!data || !data.length) {
      list.replaceWith(h('div', { class: 'card' }, emptyState({
        icon: 'folder',
        title: 'No projects yet',
        text: 'Create a project to get an API key and start uploading audio.',
        action: h('button', { class: 'btn primary', type: 'button', onclick: createProjectDialog }, icon('plus'), 'Create your first project'),
      })));
      return;
    }
    list.removeAttribute('role');
    list.removeAttribute('aria-label');
    list.replaceChildren(...data.map(projectCard));
  }

  function projectCard(p) {
    const s = p.stats || {};
    const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, String(n || 0)), h('span', null, label));
    return h('a', { class: 'proj-card', href: `#/projects/${enc(p.id)}/transcriptions` },
      h('div', { class: 'proj-top' }, avatar(p.name),
        h('div', null, h('h2', null, p.name), h('p', { class: 'muted' }, 'Created ', timeEl(p.created_at)))),
      h('div', { class: 'stats' },
        stat(s.transcriptions, 'Total'), stat(s.completed, 'Done'), stat(s.queued, 'In queue'), stat(s.failed, 'Failed')),
      h('div', { class: 'proj-foot' }, roleBadge(p.role),
        h('span', { class: 'badge' }, engineLabel(p.default_engine)),
        h('span', { class: 'badge' }, langLabel(p.default_language))));
  }

  function createProjectDialog() {
    const name = h('input', { type: 'text', required: true, maxlength: '190', placeholder: 'e.g. Call center QA', autocomplete: 'off' });
    formDialog({
      title: 'New project',
      submitLabel: 'Create project',
      body: [field('Project name', name, { hint: 'You can rename it later in Settings.' })],
      onSubmit: async () => {
        const p = await api('projects', { method: 'POST', body: { name: name.value.trim() } });
        toast(`Project “${p.name}” created. Create an API key to start using it.`, 'success');
        navigate(`/projects/${enc(p.id)}/keys`);
      },
    });
  }

  // ================================================================ view: project (shell + tabs)

  const TAB_RENDERERS = {
    transcriptions: tabTranscriptions,
    keys: tabKeys,
    members: tabMembers,
    settings: tabSettings,
    docs: tabDocs,
  };

  async function viewProject(ctx, params) {
    const id = params[0];
    const tab = params[1];
    if (!tab || !TAB_RENDERERS[tab]) return navigate(`/projects/${enc(id)}/transcriptions`, true);

    let sh = shell;
    if (!sh || sh.id !== id || !$view.contains(sh.root)) {
      setView(loadingState('Loading project…'));
      const project = await api('projects/' + enc(id));
      if (!ctx.alive) return;
      sh = shell = buildShell(project);
      setView(sh.root);
    }
    for (const [tabId, a] of Object.entries(sh.links)) {
      if (tabId === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    revealTab(sh.nav, sh.links[tab]);
    document.title = `${TABS.find((t) => t.id === tab).label} · ${sh.project.name} · ${APP_NAME}`;
    sh.panel.replaceChildren(loadingState());
    try {
      await TAB_RENDERERS[tab](ctx, sh, sh.panel);
    } catch (err) {
      if (!ctx.alive || err.status === 401) return;
      if (!(err instanceof ApiError)) console.error(err);
      sh.panel.replaceChildren(h('div', { class: 'card' }, errorState(err, () => onRoute())));
    }
  }

  /** Scrolls the (horizontally scrolling) tab strip so the current tab is visible; never scrolls the page. */
  function revealTab(nav, tab) {
    const n = nav.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    if (r.left < n.left) nav.scrollLeft -= n.left - r.left + 24;
    else if (r.right > n.right) nav.scrollLeft += r.right - n.right + 24;
  }

  function buildShell(p) {
    const sh = {
      id: p.id,
      project: p,
      title: h('h1', null),
      role: h('span'),
      meta: h('p', { class: 'muted' }),
      nav: h('nav', { class: 'tabs', 'aria-label': 'Project sections' }),
      panel: h('div', { class: 'tab-panel' }),
      links: {},
    };
    for (const t of TABS) {
      sh.links[t.id] = h('a', { class: 'tab', href: `#/projects/${enc(p.id)}/${t.id}` }, icon(t.icon), t.label);
      sh.nav.append(sh.links[t.id]);
    }
    sh.root = h('div', { class: 'project' },
      h('a', { class: 'back', href: '#/projects' }, icon('arrowLeft'), 'All projects'),
      h('div', { class: 'page-head' }, h('div', { class: 'page-title' }, h('div', { class: 'title-row' }, sh.title, sh.role), sh.meta)),
      sh.nav, sh.panel);
    updateShell(sh, p);
    return sh;
  }

  function updateShell(sh, p) {
    const oldName = sh.project.name;
    sh.project = Object.assign({}, sh.project, p);
    const proj = sh.project;
    sh.title.textContent = proj.name;
    if (oldName && oldName !== proj.name) document.title = document.title.replace(oldName, proj.name);
    sh.role.replaceWith(sh.role = roleBadge(proj.role));
    sh.meta.replaceChildren('Created ', timeEl(proj.created_at), ` · Default engine: ${engineLabel(proj.default_engine)} · Language: ${langLabel(proj.default_language)}`);
    if (sh.onProjectChange) sh.onProjectChange();
  }

  // ---------------------------------------------------------------- tab: transcriptions

  async function tabTranscriptions(ctx, sh, panel) {
    const p = sh.project;
    const list = transcriptionList(ctx, p);
    panel.replaceChildren(uploadCard(ctx, p), list.el);
    ctx.onCleanup(uploads.on('done', (item) => { if (item.projectId === p.id) list.load(true); }));
    await list.load();
  }

  function uploadCard(ctx, p) {
    const conf = cfg();
    const exts = allowedExts();
    const engines = enginesEnabled();
    const maxMb = Number(conf.max_upload_mb) || 100;
    const cloudMb = Number(conf.cloud_max_mb) || 25;
    const staged = [];

    const input = h('input', {
      type: 'file', multiple: true, hidden: true, tabindex: '-1',
      accept: exts.map((e) => '.' + e).join(','),
      onchange: () => { addFiles(input.files); input.value = ''; },
    });
    const hintId = uid('drop-hint');
    const drop = h('button', { type: 'button', class: 'drop', 'aria-describedby': hintId, disabled: !engines.length, onclick: () => input.click() },
      icon('upload', 'drop-icon'),
      h('span', { class: 'drop-title' }, 'Drop audio files here, or click to choose'),
      h('span', { class: 'drop-hint', id: hintId },
        `${exts.map((e) => '.' + e).join(', ')} · up to ${maxMb} MB` + (engines.includes('cloud') ? ` (cloud engine: ${cloudMb} MB)` : '')));

    let dragDepth = 0;
    drop.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('over'); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    drop.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      drop.classList.remove('over');
      if (!drop.disabled) addFiles(e.dataTransfer.files);
    });

    // Options
    const lang = languageSelect(p.default_language || '');
    const task = h('select', null,
      h('option', { value: 'transcribe' }, 'Transcribe (same language)'),
      h('option', { value: 'translate' }, 'Translate to English'));
    const engine = h('select', null, engines.map((e) => h('option', { value: e }, `${ENGINE_LABELS[e]} (${ENGINE_HINTS[e]})`)));
    engine.value = engines.includes(p.default_engine) ? p.default_engine : (engines[0] || '');
    const prompt = h('textarea', { rows: '2', maxlength: '1000', placeholder: 'Names, products or jargon to spell correctly…' });
    const promptField = field('Prompt (optional)', prompt, { class: 'span-all', hint: 'Vocabulary hints for the cloud engine, up to 1000 characters.' });
    const syncEngine = () => { promptField.hidden = engine.value !== 'cloud'; renderStaged(); };
    engine.addEventListener('change', syncEngine);

    // Staged files (validated before upload)
    const stagedList = h('ul', { class: 'file-list', 'aria-label': 'Selected files' });
    const startLabel = h('span', null, 'Upload & transcribe');
    const startBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: start }, icon('upload'), startLabel);
    const summary = h('p', { class: 'hint' });

    function validate(file) {
      const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
      if (!exts.includes(ext)) return `Unsupported file type. Allowed: ${exts.map((e) => '.' + e).join(', ')}.`;
      if (file.size === 0) return 'The file is empty.';
      if (file.size > maxMb * 1048576) return `Too large — the limit is ${maxMb} MB.`;
      if (engine.value === 'cloud' && file.size > cloudMb * 1048576) {
        return `Too large for the cloud engine (max ${cloudMb} MB).` + (engines.includes('worker') ? ' Choose “PC worker” instead.' : '');
      }
      return null;
    }

    function addFiles(fileList) {
      for (const f of Array.from(fileList || [])) {
        if (!staged.some((s) => s.name === f.name && s.size === f.size)) staged.push(f);
      }
      renderStaged();
    }

    function renderStaged() {
      stagedList.hidden = !staged.length;
      stagedList.replaceChildren(...staged.map((file, i) => {
        const problem = validate(file);
        return h('li', { class: ['file-item', problem && 'invalid'] },
          icon(problem ? 'alert' : 'file'),
          h('span', { class: 'file-name', title: file.name }, file.name),
          h('span', { class: 'file-size' }, fmtBytes(file.size)),
          h('button', {
            class: 'icon-btn small', type: 'button', 'aria-label': 'Remove ' + file.name,
            onclick: () => { staged.splice(i, 1); renderStaged(); },
          }, icon('x')),
          problem && h('span', { class: 'file-error' }, problem));
      }));
      const valid = staged.filter((f) => !validate(f)).length;
      startBtn.disabled = !valid;
      startLabel.textContent = valid > 1 ? `Upload ${valid} files` : 'Upload & transcribe';
      summary.textContent = staged.length ? `${plural(staged.length, 'file')} selected` + (valid < staged.length ? ` · ${staged.length - valid} can't be uploaded` : '') : '';
    }

    function start() {
      const ready = staged.filter((f) => !validate(f));
      if (!ready.length) return;
      const fields = { engine: engine.value, task: task.value };
      if (lang.value) fields.language = lang.value;
      else if (p.default_language) fields.language = 'auto'; // explicit auto-detect overrides the project default
      if (engine.value === 'cloud' && prompt.value.trim()) fields.prompt = prompt.value.trim();
      uploads.add(p.id, ready, fields);
      for (const f of ready) staged.splice(staged.indexOf(f), 1);
      renderStaged();
    }

    // Upload progress (global queue, filtered to this project)
    const upList = h('ul', { class: 'file-list', 'aria-label': 'Uploads' });
    const upWrap = h('div', { class: 'uploads', hidden: true },
      h('div', { class: 'uploads-head' }, h('h3', null, 'Uploads'),
        h('button', { class: 'link-btn small', type: 'button', onclick: () => uploads.clearFinished(p.id) }, 'Clear finished')),
      upList);
    const rows = new Map();

    function renderUploads() {
      const items = uploads.items.filter((i) => i.projectId === p.id);
      upWrap.hidden = !items.length;
      for (const [item, row] of rows) {
        if (!items.includes(item)) { row.el.remove(); rows.delete(item); }
      }
      for (const item of items) {
        let row = rows.get(item);
        if (!row) {
          row = uploadRow(item);
          rows.set(item, row);
          upList.append(row.el);
        }
        updateUploadRow(row, item);
      }
    }
    ctx.onCleanup(uploads.on('change', renderUploads));

    const options = h('div', { class: 'form-grid options' },
      field('Language', lang), field('Task', task), field('Engine', engine), promptField);

    const titleId = uid('upload-title');
    const card = h('section', { class: 'card', 'aria-labelledby': titleId },
      h('div', { class: 'card-head' }, h('div', null, h('h2', { id: titleId }, 'New transcription'),
        h('p', { class: 'muted' }, 'Upload audio here, or send it from your app with an API key.'))),
      !engines.length && callout('warn', 'No engine available', 'Both the cloud and the PC worker engines are disabled on the server. Enable one in config.php.'),
      drop, input, stagedList, options,
      h('div', { class: 'upload-actions' }, summary, startBtn),
      upWrap);
    syncEngine();
    renderUploads();
    return card;
  }

  function uploadRow(item) {
    const bar = h('progress', { max: '100', 'aria-label': 'Upload progress for ' + item.file.name });
    const status = h('span', { class: 'up-status' });
    const action = h('span', { class: 'up-action' });
    const el = h('li', { class: 'up-item' }, icon('file'),
      h('div', { class: 'up-main' }, h('div', { class: 'up-top' }, h('span', { class: 'file-name', title: item.file.name }, item.file.name), status), bar),
      action);
    return { el, bar, status, action, shown: null };
  }

  function updateUploadRow(row, item) {
    const pct = item.total ? Math.min(100, Math.round(item.loaded / item.total * 100)) : 0;
    row.el.className = 'up-item is-' + item.status;
    row.bar.hidden = item.status !== 'uploading' && item.status !== 'waiting';
    if (item.status === 'uploading') {
      row.bar.value = pct;
      row.status.textContent = pct >= 100 ? 'Saving…' : `${pct}% · ${fmtBytes(item.loaded)} of ${fmtBytes(item.total)}`;
    } else if (item.status === 'waiting') {
      row.bar.removeAttribute('value');
      row.status.textContent = 'Waiting…';
    } else if (item.status === 'done') {
      const r = item.result || {};
      row.status.textContent = r.status === 'completed' ? 'Done' : 'Uploaded · ' + (STATUS_LABELS[r.status] || 'queued').toLowerCase();
    } else if (item.status === 'error') {
      row.status.textContent = item.error || 'Upload failed';
    } else {
      row.status.textContent = 'Cancelled';
    }
    // Rebuild the action button only when the state changes, so keyboard focus is not lost mid-upload.
    if (row.shown === item.status) return;
    row.shown = item.status;
    const name = item.file.name;
    let btn = null;
    if (item.status === 'waiting' || item.status === 'uploading') {
      btn = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Cancel upload of ' + name, onclick: () => uploads.cancel(item) }, 'Cancel');
    } else if (item.status === 'done' && item.result && item.result.id) {
      btn = h('a', { class: 'btn small', href: '#/transcriptions/' + enc(item.result.id) }, 'Open');
    } else if (item.status === 'error') {
      btn = [h('button', { class: 'btn small', type: 'button', onclick: () => uploads.retry(item) }, 'Retry'),
        h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Dismiss ' + name, onclick: () => uploads.dismiss(item) }, icon('x'))];
    } else {
      btn = h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Dismiss ' + name, onclick: () => uploads.dismiss(item) }, icon('x'));
    }
    const hadFocus = row.action.contains(document.activeElement);
    row.action.replaceChildren(...[btn].flat());
    if (hadFocus && row.action.firstElementChild) row.action.firstElementChild.focus();
  }

  function transcriptionList(ctx, p) {
    const st = { status: '', offset: 0, timer: 0, total: 0, count: 0, seq: 0 };
    const filter = h('select', { class: 'compact', 'aria-label': 'Filter by status' },
      h('option', { value: '' }, 'All statuses'), STATUSES.map((s) => h('option', { value: s }, STATUS_LABELS[s])));
    filter.addEventListener('change', () => { st.status = filter.value; st.offset = 0; load(); });
    const refresh = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh list', title: 'Refresh', onclick: () => load() }, icon('refresh'));
    const count = h('span', { class: 'count' });
    const body = h('div', { class: 'tr-list' }, skeleton('row', 3));
    const prev = h('button', { class: 'btn small', type: 'button', onclick: () => { st.offset = Math.max(0, st.offset - PAGE_SIZE); load(); } }, icon('chevronLeft'), 'Newer');
    const next = h('button', { class: 'btn small', type: 'button', onclick: () => { st.offset += PAGE_SIZE; load(); } }, 'Older', icon('chevronRight'));
    const range = h('span', { class: 'muted' });
    const pager = h('div', { class: 'pager', hidden: true }, range, h('div', { class: 'cluster' }, prev, next));
    const el = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Transcriptions ', count), h('div', { class: 'list-tools' }, filter, refresh)),
      body, pager);

    async function load(silent) {
      clearTimeout(st.timer);
      if (!ctx.alive) return;
      // Only the newest request may render: a slow auto-refresh for the old filter/page must not
      // overwrite the result of a filter or page change made meanwhile.
      const seq = ++st.seq;
      if (!silent) body.setAttribute('aria-busy', 'true');
      let res;
      try {
        res = await api(`projects/${enc(p.id)}/transcriptions?` + qs({ status: st.status, limit: PAGE_SIZE, offset: st.offset }));
      } catch (e) {
        if (!ctx.alive || e.status === 401 || seq !== st.seq) return;
        if (silent) { if (!e.status || e.status >= 500) schedule(); return; }
        body.replaceChildren(errorState(e, () => load()));
        pager.hidden = true;
        return;
      } finally {
        if (seq === st.seq) body.removeAttribute('aria-busy');
      }
      if (!ctx.alive || seq !== st.seq) return;
      const items = res.data || [];
      if (!items.length && st.offset > 0) { st.offset = Math.max(0, st.offset - PAGE_SIZE); return load(silent); }
      render(items, res.total != null ? res.total : items.length);
      if (items.some(isActive)) schedule();
    }

    // Auto-refresh only while something on screen is still queued/processing.
    function schedule() {
      st.timer = ctx.timeout(() => (document.hidden ? schedule() : load(true)), POLL_MS);
    }

    function render(items, total) {
      count.textContent = total ? `(${total})` : '';
      if (!items.length) {
        body.replaceChildren(st.status
          ? emptyState({ icon: 'search', title: `No ${STATUS_LABELS[st.status].toLowerCase()} transcriptions`, text: 'Try a different status filter.' })
          : emptyState({ icon: 'wave', title: 'No transcriptions yet', text: 'Drop an audio file above, or call the API from your app — the Docs tab has ready-to-run examples.' }));
      } else {
        const focusedId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.id : null;
        body.replaceChildren(...items.map(transcriptionRow));
        if (focusedId) {
          const again = Array.from(body.children).find((r) => r.dataset.id === focusedId);
          if (again) again.focus();
        }
      }
      pager.hidden = total <= PAGE_SIZE && st.offset === 0;
      range.textContent = items.length ? `${st.offset + 1}–${st.offset + items.length} of ${total}` : '';
      prev.disabled = st.offset === 0;
      next.disabled = st.offset + items.length >= total;
    }

    return { el, load };
  }

  function transcriptionRow(t) {
    const meta = [];
    if (t.duration != null) meta.push(fmtDuration(t.duration));
    if (t.file_size != null) meta.push(fmtBytes(t.file_size));
    meta.push(engineLabel(t.engine));
    if (t.detected_language || t.language) meta.push(langLabel(t.detected_language || t.language));
    if (t.task === 'translate') meta.push('→ English');

    let extra = null;
    if (t.status === 'processing') {
      extra = h('span', { class: 'tr-progress' },
        h('progress', { max: '100', value: t.progress != null ? String(t.progress) : null, 'aria-label': 'Progress' }),
        h('span', null, t.progress != null ? t.progress + '%' : 'Working…'));
    } else if (t.status === 'queued') {
      extra = h('span', { class: 'tr-meta' }, t.engine === 'worker' ? 'Waiting for a PC worker…' : 'Waiting to start…');
    } else if (t.status === 'failed' && t.error) {
      extra = h('span', { class: 'tr-error', title: t.error }, t.error);
    }

    return h('a', { class: ['tr-row', 'is-' + t.status], href: '#/transcriptions/' + enc(t.id), dataset: { id: t.id } },
      h('span', { class: 'tr-icon', 'aria-hidden': 'true' }, icon(t.status === 'failed' ? 'alert' : 'file')),
      h('span', { class: 'tr-main' },
        h('span', { class: 'tr-name', title: t.filename }, t.filename || t.id),
        h('span', { class: 'tr-meta' }, meta.join(' · '), ' · ', timeEl(t.created_at)),
        extra),
      statusBadge(t));
  }

  // ---------------------------------------------------------------- tab: API keys

  async function tabKeys(ctx, sh, panel) {
    const p = sh.project;
    if (!isOwner(p)) {
      panel.replaceChildren(h('div', { class: 'card' }, emptyState({
        icon: 'lock', title: 'Only owners manage API keys',
        text: 'Ask a project owner for a key. You can still upload in the dashboard and read the Docs tab.',
      })));
      return;
    }

    const name = h('input', { type: 'text', required: true, maxlength: '190', placeholder: 'e.g. Production server', autocomplete: 'off' });
    const err = formError();
    const createBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Create key');
    const list = h('div', { class: 'rows' }, skeleton('row', 2));
    const form = h('form', {
      class: 'inline-form',
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(createBtn, async () => {
          clearError(err);
          try {
            const key = await api(`projects/${enc(p.id)}/keys`, { method: 'POST', body: { name: name.value.trim() } });
            name.value = '';
            showNewKey(key);
            load();
          } catch (ex) {
            if (ex.status !== 401) setError(err, ex.message);
          }
        });
      },
    }, field('New key name', name), createBtn);

    panel.replaceChildren(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'API keys'),
        h('p', { class: 'muted' }, 'Keys authenticate your apps against this project. Send one as ', h('code', null, 'Authorization: Bearer tk_…'), '.'))),
      form, err, h('div', { class: 'sep' }, list)));

    async function load() {
      const { data } = await api(`projects/${enc(p.id)}/keys`);
      if (!ctx.alive) return;
      if (!data || !data.length) {
        list.replaceChildren(emptyState({ icon: 'key', title: 'No API keys yet', text: 'Create a key above, then follow the Docs tab to send your first file.' }));
        return;
      }
      const sorted = data.slice().sort((a, b) => (a.revoked_at ? 1 : 0) - (b.revoked_at ? 1 : 0));
      list.replaceChildren(...sorted.map(keyRow));
    }

    function keyRow(k) {
      const revoked = !!k.revoked_at;
      return h('div', { class: ['row-item', revoked && 'dim'] },
        h('span', { class: 'ri-icon', 'aria-hidden': 'true' }, icon('key')),
        h('div', { class: 'ri-main' },
          h('div', { class: 'ri-title' }, k.name || 'Unnamed key', h('code', null, (k.prefix || 'tk_') + '…')),
          h('div', { class: 'ri-sub' }, 'Created ', timeEl(k.created_at), ' · ',
            k.last_used_at ? ['Last used ', timeEl(k.last_used_at)] : 'Never used')),
        h('div', { class: 'ri-actions' },
          revoked
            ? h('span', { class: 'badge bad', title: absTime(k.revoked_at) }, 'Revoked ' + relTime(k.revoked_at))
            : [h('span', { class: 'badge ok' }, 'Active'),
              h('button', { class: 'btn small danger-ghost', type: 'button', onclick: () => revoke(k) }, 'Revoke')]));
    }

    async function revoke(k) {
      const ok = await confirmDialog({
        title: 'Revoke API key?',
        message: ['Apps using “', k.name || k.prefix, '” will immediately get ', h('code', null, '401 invalid_api_key'), '. This cannot be undone.'],
        confirmLabel: 'Revoke key',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`projects/${enc(p.id)}/keys/${enc(k.id)}`, { method: 'DELETE' });
        toast('API key revoked', 'success');
        if (ctx.alive) load();
      } catch (e) { toastError(e); }
    }

    await load();
  }

  function showNewKey(k) {
    const value = h('input', { type: 'text', readOnly: true, value: k.key || '', 'aria-label': 'Your new API key', spellcheck: 'false' });
    value.addEventListener('focus', () => value.select());
    const copy = h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(k.key, 'API key copied') }, icon('copy'), 'Copy');
    const dlg = openDialog('Your new API key', h('div', null,
      h('div', { class: 'modal-body stack' },
        callout('warn', 'Copy it now — it is shown only once.', 'Only a hash is stored on the server, so this key cannot be displayed again. If you lose it, revoke it and create a new one.'),
        h('div', { class: 'copy-field' }, value, copy),
        h('p', { class: 'muted small' }, 'Send it as ', h('code', null, 'Authorization: Bearer ' + (k.prefix || 'tk_') + '…'), ' or ', h('code', null, 'X-API-Key'), '. The Docs tab has examples.')),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.dismiss() }, 'I’ve saved it'))),
    { dismissable: false, focus: copy });
  }

  // ---------------------------------------------------------------- tab: members

  async function tabMembers(ctx, sh, panel) {
    const p = sh.project;
    const owner = isOwner(p);
    const list = h('div', { class: 'rows' }, skeleton('row', 2));

    let form = null;
    const err = formError();
    if (owner) {
      const email = h('input', { type: 'email', required: true, placeholder: 'colleague@example.com', autocomplete: 'off', spellcheck: 'false' });
      const addBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add member');
      form = h('form', {
        class: 'inline-form',
        onsubmit: (e) => {
          e.preventDefault();
          withBusy(addBtn, async () => {
            clearError(err);
            try {
              await api(`projects/${enc(p.id)}/members`, { method: 'POST', body: { email: email.value.trim(), role: 'member' } });
              toast(`${email.value.trim()} added to the project`, 'success');
              email.value = '';
              load();
            } catch (ex) {
              if (ex.status !== 401) setError(err, ex.message);
            }
          });
        },
      }, field('Add by email', email, { hint: 'The person needs an account on this server first.' }), addBtn);
    }

    panel.replaceChildren(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Members'),
        h('p', { class: 'muted' }, 'Members can upload and read transcripts. Owners also manage keys, settings and members.'))),
      form, err, h('div', { class: form ? 'sep' : null }, list)));

    async function load() {
      const { data } = await api(`projects/${enc(p.id)}/members`);
      if (!ctx.alive) return;
      const members = data || [];
      const owners = members.filter((m) => m.role === 'owner').length;
      list.replaceChildren(...members.map((m) => {
        const self = state.user && m.user_id === state.user.id;
        const canRemove = owner && !(m.role === 'owner' && owners <= 1);
        return h('div', { class: 'row-item' },
          avatar(m.name || m.email),
          h('div', { class: 'ri-main' },
            h('div', { class: 'ri-title' }, m.name || m.email, self && h('span', { class: 'badge' }, 'You')),
            h('div', { class: 'ri-sub' }, m.email, ' · joined ', timeEl(m.created_at))),
          h('div', { class: 'ri-actions' }, roleBadge(m.role),
            canRemove && h('button', { class: 'btn small danger-ghost', type: 'button', onclick: () => remove(m, self) }, self ? 'Leave' : 'Remove')));
      }));
      if (!members.length) list.replaceChildren(emptyState({ icon: 'users', title: 'No members', text: 'Add people by email above.' }));
    }

    async function remove(m, self) {
      const ok = await confirmDialog({
        title: self ? 'Leave this project?' : 'Remove member?',
        message: self
          ? 'You will lose access to its transcripts and settings.'
          : [m.name || m.email, ' will lose access to this project’s transcripts.'],
        confirmLabel: self ? 'Leave project' : 'Remove',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`projects/${enc(p.id)}/members/${enc(m.user_id)}`, { method: 'DELETE' });
        toast(self ? 'You left the project' : 'Member removed', 'success');
        if (self) { shell = null; navigate('/projects'); } else if (ctx.alive) load();
      } catch (e) { toastError(e); }
    }

    await load();
  }

  // ---------------------------------------------------------------- tab: settings

  async function tabSettings(ctx, sh, panel) {
    // Refresh so we have the latest values (and the webhook secret, which only owners receive).
    const fresh = await api('projects/' + enc(sh.id));
    if (!ctx.alive) return;
    updateShell(sh, fresh);
    const p = sh.project;

    if (!isOwner(p)) {
      panel.replaceChildren(h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Project settings'), h('p', { class: 'muted' }, 'Only owners can change these.'))),
        h('dl', { class: 'meta' },
          metaItem('Name', p.name), metaItem('Default engine', engineLabel(p.default_engine)),
          metaItem('Default language', langLabel(p.default_language)), metaItem('Webhook URL', p.webhook_url || 'Not set'))));
      return;
    }

    panel.replaceChildren(generalCard(sh), webhookSecretCard(sh), dangerCard(sh));
  }

  function generalCard(sh) {
    const p = sh.project;
    const engines = enginesEnabled();
    const name = h('input', { type: 'text', required: true, maxlength: '190', value: p.name || '' });
    const engine = h('select', null, ENGINES.map((e) => h('option', { value: e }, ENGINE_LABELS[e] + (engines.includes(e) ? '' : ' (disabled on server)'))));
    engine.value = p.default_engine || 'cloud';
    const lang = languageSelect(p.default_language || '');
    const webhook = h('input', { type: 'url', value: p.webhook_url || '', placeholder: 'https://example.com/hooks/transcribe', spellcheck: 'false', autocomplete: 'off' });
    const err = formError();
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save changes');
    return h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(save, async () => {
          clearError(err);
          try {
            const updated = await api('projects/' + enc(p.id), {
              method: 'PATCH',
              body: { name: name.value.trim(), default_engine: engine.value, default_language: lang.value || null, webhook_url: webhook.value.trim() || null },
            });
            updateShell(sh, updated && updated.id ? updated : { name: name.value.trim(), default_engine: engine.value, default_language: lang.value || null, webhook_url: webhook.value.trim() || null });
            toast('Settings saved', 'success');
          } catch (ex) {
            if (ex.status !== 401) setError(err, ex.message);
          }
        });
      },
    },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'General'), h('p', { class: 'muted' }, 'Defaults apply when a request does not specify them.'))),
    h('div', { class: 'form-grid' },
      field('Project name', name, { class: 'span-all' }),
      field('Default engine', engine),
      field('Default language', lang),
      field('Webhook URL', webhook, { class: 'span-all', hint: 'Receives a signed POST when a transcription completes or fails. Leave empty to turn webhooks off. Requests can override it with webhook_url.' })),
    err,
    h('div', { class: 'form-actions' }, save));
  }

  function webhookSecretCard(sh) {
    const p = sh.project;
    let secret = p.webhook_secret || '';
    let shown = false;
    const mask = (s) => (s ? s.slice(0, 6) + '•'.repeat(Math.max(8, Math.min(32, s.length - 6))) : '');
    const value = h('input', { type: 'text', readOnly: true, 'aria-label': 'Webhook signing secret', spellcheck: 'false' });
    const toggleLabel = h('span', null, 'Show');
    const toggleIcon = h('span', { class: 'cluster' }, icon('eye'));
    const toggle = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: () => { shown = !shown; render(); } }, toggleIcon, toggleLabel);
    const copy = h('button', { class: 'btn', type: 'button', onclick: () => copyText(secret, 'Webhook secret copied') }, icon('copy'), 'Copy');
    const rotate = h('button', { class: 'btn danger-ghost', type: 'button', onclick: doRotate }, icon('rotate'), 'Rotate');

    function render() {
      value.value = shown ? secret : mask(secret);
      toggleLabel.textContent = shown ? 'Hide' : 'Show';
      toggleIcon.replaceChildren(icon(shown ? 'eyeOff' : 'eye'));
      toggle.setAttribute('aria-pressed', String(shown));
      toggle.disabled = copy.disabled = !secret;
    }

    async function doRotate() {
      const ok = await confirmDialog({
        title: 'Rotate webhook secret?',
        message: 'A new secret is generated immediately. Receivers that verify signatures will reject webhooks until you update them with the new secret.',
        confirmLabel: 'Rotate secret',
        danger: true,
      });
      if (!ok) return;
      await withBusy(rotate, async () => {
        try {
          const res = await api(`projects/${enc(p.id)}/webhook-secret`, { method: 'POST' });
          secret = res.webhook_secret || '';
          sh.project.webhook_secret = secret;
          shown = true;
          render();
          toast('New webhook secret generated', 'success');
        } catch (e) { toastError(e); }
      });
    }

    render();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Webhook signing secret'),
        h('p', { class: 'muted' }, 'Each webhook carries ', h('code', null, 'X-Transcribe-Signature: sha256=…'), ' — an HMAC-SHA256 of the raw body with this secret. See the Docs tab for verification code.'))),
      secret ? h('div', { class: 'copy-field' }, value, toggle) : callout('info', null, 'The server did not return a secret for this project.'),
      h('div', { class: 'form-actions' }, copy, rotate));
  }

  function dangerCard(sh) {
    const p = sh.project;
    const confirmInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const del = h('button', { class: 'btn danger', type: 'button', disabled: true }, icon('trash'), 'Delete project');
    const nameEl = h('strong', null, p.name);
    const sync = () => { del.disabled = confirmInput.value.trim() !== sh.project.name; };
    // A rename in the General card replaces sh.project: show (and expect) the new name.
    sh.onProjectChange = () => { nameEl.textContent = sh.project.name; sync(); };
    confirmInput.addEventListener('input', sync);
    del.addEventListener('click', () => withBusy(del, async () => {
      try {
        await api('projects/' + enc(p.id), { method: 'DELETE' });
        shell = null;
        toast(`Project “${sh.project.name}” deleted`, 'success');
        navigate('/projects');
      } catch (e) { toastError(e); }
    }).then(() => { if (del.isConnected) sync(); }));
    return h('section', { class: 'card danger-zone' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Delete project'),
        h('p', { class: 'muted' }, 'Permanently removes the project with all its transcripts, audio files, API keys and members. This cannot be undone.'))),
      h('div', { class: 'inline-form' }, field(['Type ', nameEl, ' to confirm'], confirmInput), del));
  }

  function metaItem(label, value) {
    return h('div', null, h('dt', null, label), h('dd', null, value));
  }

  // ---------------------------------------------------------------- tab: docs

  function tabDocs(ctx, sh, panel) {
    const p = sh.project;
    const base = baseUrl();
    const engines = enginesEnabled();
    const conf = cfg();
    let shellKind = loadPref('docs-shell', 'bash') === 'ps' ? 'ps' : 'bash';
    const shellBlocks = [];

    // Shell-aware code block: regenerated when the Bash/PowerShell toggle changes.
    const shellCode = (label, gen) => {
      const block = codeBlock(gen(shellKind), label);
      shellBlocks.push({ block, gen });
      return block;
    };
    const toggleBtns = [['bash', 'Bash / macOS / Linux'], ['ps', 'PowerShell']].map(([kind, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(shellKind === kind), onclick: () => setShell(kind) }, label));
    function setShell(kind) {
      shellKind = kind;
      savePref('docs-shell', kind);
      toggleBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['bash', 'ps'][i] === kind)));
      shellBlocks.forEach(({ block, gen }) => block.setCode(gen(kind)));
    }

    const curl = (kind, args) => (kind === 'ps' ? 'curl.exe ' : 'curl ') + args.join(kind === 'ps' ? ' `\n  ' : ' \\\n  ');
    const auth = (kind) => `-H "Authorization: Bearer ${kind === 'ps' ? '$env:TRANSCRIBE_API_KEY' : '$TRANSCRIBE_API_KEY'}"`;
    const setKey = (kind) => (kind === 'ps' ? '$env:TRANSCRIBE_API_KEY = "tk_your_api_key"' : 'export TRANSCRIBE_API_KEY="tk_your_api_key"');
    const exampleLang = p.default_language || 'en';
    const asyncEngine = engines.includes('worker') ? 'worker' : 'cloud';

    const sections = [];
    const section = (id, title, ...content) => {
      // tabindex -1: the table of contents moves keyboard focus to the heading it scrolls to.
      const heading = h('h2', { tabindex: '-1' }, title);
      const el = h('section', { class: 'card', id: 'docs-' + id }, heading, content);
      sections.push({ title, el, heading });
      return el;
    };
    const engineState = (e) => h('span', { class: ['badge', engines.includes(e) ? 'ok' : 'bad'] }, `${ENGINE_LABELS[e]}: ${engines.includes(e) ? 'enabled' : 'disabled'}`);

    const quick = section('start', 'Quick start',
      h('p', null, 'All requests go to this server and authenticate with a project API key (', h('a', { href: `#/projects/${enc(p.id)}/keys` }, 'create one in API keys'), '). Keys are scoped to this project.'),
      h('div', { class: 'copy-field mt' },
        h('input', { type: 'text', readOnly: true, value: base, 'aria-label': 'API base URL' }),
        h('button', { class: 'btn', type: 'button', onclick: () => copyText(base, 'Base URL copied') }, icon('copy'), 'Copy')),
      h('div', { class: 'kv-line' }, engineState('cloud'), engineState('worker'),
        h('span', { class: 'badge' }, 'Formats: ' + allowedExts().map((e) => '.' + e).join(', ')),
        h('span', { class: 'badge' }, `Max ${conf.max_upload_mb || 100} MB`),
        engines.includes('cloud') && h('span', { class: 'badge' }, `Cloud max ${conf.cloud_max_mb || 25} MB`)),
      shellCode('Set your key', (k) => setKey(k)));

    const transcribe = section('transcribe', 'Transcribe a file',
      engines.includes('cloud')
        ? [h('p', null, 'With ', h('code', null, 'wait=true'), ' the cloud engine processes the file inside the request and returns the finished transcript (HTTP 200). Large files can take a minute or two.'),
          shellCode('Upload and wait', (k) => curl(k, ['-X POST "' + base + '/api/v1/transcriptions"', auth(k), '-F "file=@call.mp3"', `-F "language=${exampleLang}"`, '-F "engine=cloud"', '-F "wait=true"']))]
        : callout('info', 'Cloud engine disabled', 'wait=true only applies to the cloud engine. Use the asynchronous flow below.'),
      h('h3', null, 'Queue a job and get notified'),
      h('p', null, 'Without ', h('code', null, 'wait'), ', the API answers ', h('code', null, '202'), ' with a queued transcription right away. Poll it, or pass a ', h('code', null, 'webhook_url'),
        ' (defaults to the project webhook). ', h('code', null, 'metadata'), ' is any JSON object (≤ 4 KB) echoed back in results and webhooks.'),
      shellCode('Upload asynchronously', (k) => [
        // PowerShell 5.1 mangles quotes inside native arguments, so the metadata JSON goes through a file.
        k === 'ps' && `'{"call_id":"A-1001"}' | Set-Content -Encoding ascii metadata.json`,
        curl(k, ['-X POST "' + base + '/api/v1/transcriptions"', auth(k), '-F "file=@call.mp3"', `-F "engine=${asyncEngine}"`,
          '-F "webhook_url=https://example.com/hooks/transcribe"', k === 'ps' ? '-F "metadata=<metadata.json"' : `-F 'metadata={"call_id":"A-1001"}'`]),
      ].filter(Boolean).join('\n')),
      h('p', { class: 'muted small' }, 'Optional fields: ', h('code', null, 'language'), ' (ISO-639-1, omit to auto-detect), ', h('code', null, 'task'), ' (transcribe | translate), ',
        h('code', null, 'engine'), ' (cloud | worker), ', h('code', null, 'prompt'), ' (cloud only, ≤ 1000 chars).',
        ' ', h('code', null, 'translate'), ' always produces English (on the PC worker it needs ', h('code', null, 'TRANSLATE_MODEL'), ', see PC worker below).'),
      h('h3', null, 'Response'),
      codeBlock(JSON.stringify(sampleTranscription(p.id), null, 2), 'JSON'));

    const results = section('results', 'Fetch results',
      h('p', null, 'Status goes ', h('code', null, 'queued'), ' → ', h('code', null, 'processing'), ' → ', h('code', null, 'completed'), ' or ', h('code', null, 'failed'), '. ',
        h('code', null, 'text'), ' and ', h('code', null, 'segments'), ' are filled once completed.'),
      shellCode('Get one transcription', (k) => curl(k, ['"' + base + '/api/v1/transcriptions/tr_xxxxxxxxxxxxxxxxxxxxxxxx"', auth(k)])),
      h('p', null, 'Download it as plain text, subtitles or JSON with ', h('code', null, '?format=txt|srt|vtt|json'), ' (returns ', h('code', null, '409 not_ready'), ' until completed):'),
      shellCode('Download subtitles', (k) => curl(k, ['-o call.srt', '"' + base + '/api/v1/transcriptions/tr_xxxxxxxxxxxxxxxxxxxxxxxx?format=srt"', auth(k)])),
      shellCode('List and delete', (k) => [
        curl(k, ['"' + base + '/api/v1/transcriptions?status=completed&limit=20&offset=0"', auth(k)]),
        '',
        curl(k, ['-X DELETE "' + base + '/api/v1/transcriptions/tr_xxxxxxxxxxxxxxxxxxxxxxxx"', auth(k)]),
      ].join('\n')));

    const webhooks = section('webhooks', 'Webhooks',
      h('p', null, 'When a job finishes, the server POSTs JSON to the webhook URL with headers ', h('code', null, 'X-Transcribe-Event'), ', ', h('code', null, 'X-Transcribe-Delivery'),
        ' (the transcription id) and ', h('code', null, 'X-Transcribe-Signature: sha256=<hex>'), '. Reply with any 2xx; failed deliveries are retried with back-off.'),
      codeBlock(JSON.stringify({ event: 'transcription.completed', created_at: '2026-10-14T09:30:19Z', data: { id: 'tr_5f0c2a9e1b7d4c3a8e6f1a2b', object: 'transcription', status: 'completed', text: 'Hello. Thanks for taking the call…', segments: ['…'], metadata: { call_id: 'A-1001' } } }, null, 2), 'Payload'),
      h('p', null, 'Verify the signature over the ', h('strong', null, 'raw request body'), ' with the project’s webhook secret (', h('a', { href: `#/projects/${enc(p.id)}/settings` }, 'Settings'), '):'),
      codeBlock(NODE_WEBHOOK, 'Node.js'),
      codeBlock(PHP_WEBHOOK, 'PHP'));

    const n8n = section('n8n', 'n8n',
      h('h3', null, 'Option A — Transcribe API community node'),
      h('ol', null,
        h('li', null, 'Run ', h('code', null, 'npm pack'), ' inside the repository’s ', h('code', null, 'n8n-nodes-transcribe-api/'), ' folder, copy the ', h('code', null, '.tgz'), ' into ', h('code', null, '~/.n8n/nodes'),
          ' and install it there (commands below), then restart n8n. The package README covers Docker.'),
        h('li', null, 'Create a ', h('strong', null, 'Transcribe API'), ' credential: Base URL ', h('code', null, base), ' and an API key from this project.'),
        h('li', null, 'Add the ', h('strong', null, 'Transcribe API'), ' node after a node that outputs a binary file (property ', h('code', null, 'data'), '), operation ', h('strong', null, 'Transcribe'), '.'),
        h('li', null, 'Keep ', h('strong', null, 'Wait for Completion'), ' on to get the finished transcript in the same run (uses ', h('code', null, 'wait=true'), ' for cloud, polls for the PC worker).')),
      shellCode('Install the node', (k) => (k === 'ps'
        ? ['Set-Location n8n-nodes-transcribe-api; npm pack',
          'New-Item -ItemType Directory -Force "$HOME\\.n8n\\nodes" | Out-Null',
          'Copy-Item n8n-nodes-transcribe-api-*.tgz "$HOME\\.n8n\\nodes"',
          'Set-Location "$HOME\\.n8n\\nodes"; npm install --omit=peer --ignore-scripts (Get-Item .\\n8n-nodes-transcribe-api-*.tgz).FullName',
          '# then restart n8n']
        : ['cd n8n-nodes-transcribe-api && npm pack', 'mkdir -p ~/.n8n/nodes && cp n8n-nodes-transcribe-api-*.tgz ~/.n8n/nodes/',
          'cd ~/.n8n/nodes && npm install --omit=peer --ignore-scripts ./n8n-nodes-transcribe-api-*.tgz', '# then restart n8n']).join('\n')),
      h('h3', null, 'Option B — built-in HTTP Request node'),
      h('ol', null,
        h('li', null, 'Method ', h('strong', null, 'POST'), ', URL ', h('code', null, base + '/api/v1/transcriptions'), '.'),
        h('li', null, 'Authentication: ', h('strong', null, 'Generic credential type → Header Auth'), ' with name ', h('code', null, 'Authorization'), ' and value ', h('code', null, 'Bearer tk_your_api_key'), '.'),
        h('li', null, 'Send Body: ', h('strong', null, 'Form-Data'), '. Add ', h('code', null, 'file'), ' as ', h('strong', null, 'n8n Binary File'), ' (input field ', h('code', null, 'data'), '), plus ',
          h('code', null, 'wait'), ' = ', h('code', null, 'true'), ' and optionally ', h('code', null, 'language'), '.'),
        h('li', null, 'For the PC worker, skip ', h('code', null, 'wait'), ' and either poll ', h('code', null, 'GET /api/v1/transcriptions/{id}'), ' or set ', h('code', null, 'webhook_url'), ' to an n8n ', h('strong', null, 'Webhook'), ' node (POST).')),
      h('p', { class: 'muted small' }, 'Ready-made workflows to import are in the ', h('code', null, 'n8n-examples/'), ' folder of the repository.'));

    const worker = section('worker', 'PC worker',
      h('p', null, 'The ', h('strong', null, 'worker'), ' engine runs Whisper (large-v3-turbo by default) on your own computer: no per-minute cost and no cloud file-size limit. ',
        engines.includes('worker') ? 'It is enabled on this server.' : 'It is currently disabled on this server (enable it in config.php).'),
      h('ol', null,
        h('li', null, 'Install Node.js 20 or newer on the PC.'),
        h('li', null, 'Copy the ', h('code', null, 'worker/'), ' folder there and run ', h('code', null, 'npm install'), '.'),
        h('li', null, 'Copy ', h('code', null, '.env.example'), ' to ', h('code', null, '.env'), ' and fill it in — the token is one of the ', h('code', null, "worker.tokens"), ' values in the server’s ', h('code', null, 'config.php'), '.'),
        h('li', null, 'Start it with ', h('code', null, 'start-worker.bat'), ' (or ', h('code', null, 'node worker.js'), '; add ', h('code', null, '--once'), ' to process one job and exit).'),
        h('li', null, 'Upload with ', h('code', null, 'engine=worker'), '. The worker polls for jobs, reports progress and posts the transcript back. If the PC goes offline mid-job, the job is re-queued after the lease expires.')),
      codeBlock(['API_BASE=' + base, 'WORKER_TOKEN=paste-a-token-from-config.php', 'WORKER_NAME=office-pc', 'MODEL=onnx-community/whisper-large-v3-turbo', 'DEVICE=cpu', 'DTYPE=q4', 'POLL_SECONDS=10',
        '# Only needed for task=translate (large-v3-turbo cannot translate):', '# TRANSLATE_MODEL=onnx-community/whisper-small'].join('\n'), 'worker/.env'),
      h('p', { class: 'muted small' }, h('code', null, 'DTYPE=q4'), ' is what ', h('code', null, '.env.example'), ' ships: with large-v3-turbo, ', h('code', null, 'q8'),
        ' drops and repeats sentences. Translation jobs (', h('code', null, 'task=translate'), ') need ', h('code', null, 'TRANSLATE_MODEL'),
        ' on the worker; without it they fail with a clear error instead of returning untranslated text.'));

    const errors = section('errors', 'Errors',
      h('p', null, 'Errors use the HTTP status plus ', h('code', null, '{"error":{"code":"…","message":"…"}}'), '.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'simple' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'HTTP'), h('th', { scope: 'col' }, 'Code'), h('th', { scope: 'col' }, 'Meaning'))),
        h('tbody', null, [
          ['401', 'unauthorized', 'No API key was sent.'],
          ['401', 'invalid_api_key', 'Malformed, unknown or revoked key.'],
          ['404', 'not_found', 'No such transcription in this project.'],
          ['409', 'not_ready', 'Format download requested before completion.'],
          ['413', 'file_too_large', `Over ${conf.max_upload_mb || 100} MB (cloud: ${conf.cloud_max_mb || 25} MB — use engine=worker).`],
          ['415', 'unsupported_file_type', 'Extension not in ' + allowedExts().join(', ') + '.'],
          ['422', 'validation_error', 'A field is invalid; see error.field.'],
          ['429', 'rate_limited', 'Too many requests — slow down and retry.'],
          ['503', 'engine_unavailable', 'The chosen engine is disabled or not configured.'],
        ].map(([s, c, m]) => h('tr', null, h('td', null, s), h('td', null, h('code', null, c)), h('td', null, m)))))));

    const intro = h('section', { class: 'card' },
      h('div', { class: 'docs-intro' },
        h('div', null, h('h2', null, 'API documentation'), h('p', { class: 'muted' }, 'Examples are pre-filled with this server’s address.')),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Shell for examples' }, toggleBtns)),
      h('div', { class: 'toc' }, sections.map((s) => h('button', {
        type: 'button',
        onclick: () => {
          s.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          s.heading.focus({ preventScroll: true });
        },
      }, s.title))));

    panel.replaceChildren(h('div', { class: 'docs' }, intro, quick, transcribe, results, webhooks, n8n, worker, errors));
  }

  function sampleTranscription(projectId) {
    return {
      id: 'tr_5f0c2a9e1b7d4c3a8e6f1a2b', object: 'transcription', project_id: projectId,
      status: 'completed', engine: 'cloud', language: 'en', detected_language: 'en', task: 'transcribe',
      filename: 'call.mp3', file_size: 6553600, duration: 819.4, progress: 100,
      text: 'Hello. Thanks for taking the call. …',
      segments: [{ id: 0, start: 0.0, end: 2.1, text: 'Hello.' }, { id: 1, start: 4.0, end: 6.12, text: 'Thanks for taking the call.' }],
      error: null, metadata: { call_id: 'A-1001' }, webhook_status: 'delivered',
      created_at: '2026-10-14T09:30:00Z', started_at: '2026-10-14T09:30:01Z', completed_at: '2026-10-14T09:30:19Z',
    };
  }

  const NODE_WEBHOOK = [
    "import http from 'node:http';",
    "import crypto from 'node:crypto';",
    '',
    'const SECRET = process.env.TRANSCRIBE_WEBHOOK_SECRET; // whsec_…',
    '',
    'http.createServer((req, res) => {',
    '  const chunks = [];',
    "  req.on('data', (c) => chunks.push(c));",
    "  req.on('end', () => {",
    '    const raw = Buffer.concat(chunks);',
    "    const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'));",
    "    const given = Buffer.from(req.headers['x-transcribe-signature'] || '');",
    '    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {',
    "      res.writeHead(401).end('invalid signature');",
    '      return;',
    '    }',
    '    const { event, data } = JSON.parse(raw);',
    "    if (event === 'transcription.completed') console.log(data.id, data.text);",
    "    res.writeHead(204).end();",
    '  });',
    '}).listen(3000);',
  ].join('\n');

  const PHP_WEBHOOK = [
    '<?php',
    "$secret = getenv('TRANSCRIBE_WEBHOOK_SECRET'); // whsec_…",
    "$raw = file_get_contents('php://input');",
    "$given = $_SERVER['HTTP_X_TRANSCRIBE_SIGNATURE'] ?? '';",
    "$expected = 'sha256=' . hash_hmac('sha256', $raw, $secret);",
    '',
    'if (!hash_equals($expected, $given)) {',
    '    http_response_code(401);',
    "    exit('invalid signature');",
    '}',
    '',
    '$payload = json_decode($raw, true);',
    "if ($payload['event'] === 'transcription.completed') {",
    "    $t = $payload['data']; // $t['id'], $t['text'], $t['segments'], $t['metadata']",
    '}',
    'http_response_code(204);',
  ].join('\n');

  // ================================================================ view: transcript viewer

  async function viewTranscription(ctx, params) {
    const id = params[0];
    setView(loadingState('Loading transcript…'));
    let t = await api('transcriptions/' + enc(id));
    if (!ctx.alive) return;
    let projectName = shell && shell.id === t.project_id ? shell.project.name : null;
    if (!projectName) {
      const proj = await api('projects/' + enc(t.project_id)).catch(() => null);
      if (!ctx.alive) return;
      projectName = proj ? proj.name : null;
    }
    document.title = (t.filename || 'Transcript') + ' · ' + APP_NAME;

    const player = createPlayer(t.id);
    ctx.onCleanup(() => player.destroy());
    const content = h('div', { class: 'viewer' });
    const backHref = `#/projects/${enc(t.project_id)}/transcriptions`;
    let body = null;

    // Full re-render, keeping keyboard focus on the equivalent control (same label) when it still exists.
    function render() {
      const focused = content.contains(document.activeElement) ? focusKey(document.activeElement) : null;
      body = viewerBody(t, player);
      content.replaceChildren(viewerHead(t, player, () => remove()), body);
      if (focused) {
        const again = Array.from(content.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')).find((el) => focusKey(el) === focused);
        if (again) again.focus();
      }
    }

    async function remove() {
      const ok = await confirmDialog({
        title: 'Delete transcription?',
        message: ['“', t.filename || t.id, '” and its audio will be permanently deleted.'],
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('transcriptions/' + enc(t.id), { method: 'DELETE' });
        toast('Transcription deleted', 'success');
        navigate(backHref.slice(1));
      } catch (e) { toastError(e); }
    }

    // While queued/processing, poll for progress; re-render when anything visible changes.
    function poll() {
      ctx.timeout(async () => {
        if (document.hidden) return poll();
        try {
          const nt = await api('transcriptions/' + enc(id));
          if (!ctx.alive) return;
          if (nt.status === t.status && nt.progress !== t.progress && body && body.updateProgress) {
            t = nt;
            body.updateProgress(t.progress); // in place: focus and screen-reader position stay put
          } else if (nt.status !== t.status || nt.progress !== t.progress) {
            t = nt;
            render();
            if (t.status === 'completed') toast('Transcript ready', 'success');
          }
        } catch (e) {
          if (!ctx.alive || (e.status && e.status < 500)) return;
        }
        if (isActive(t)) poll();
      }, POLL_MS);
    }

    render();
    setView(h('a', { class: 'back', href: backHref }, icon('arrowLeft'), projectName || 'Back to project'), content);
    document.body.append(player.el);
    if (isActive(t)) poll();
  }

  /** Identifies a control across re-renders: tag plus accessible label (aria-label, else its text). */
  function focusKey(el) {
    return `${el.tagName}|${el.getAttribute('aria-label') || el.textContent.trim()}`;
  }

  function viewerHead(t, player, onDelete) {
    const done = t.status === 'completed';
    const base = baseName(t.filename);
    const lang = t.language
      ? langLabel(t.language) + (t.detected_language && t.detected_language !== t.language ? ` (detected ${langLabel(t.detected_language)})` : '')
      : (t.detected_language ? `Auto → ${langLabel(t.detected_language)}` : 'Auto-detect');
    const took = t.started_at && t.completed_at ? (Date.parse(t.completed_at) - Date.parse(t.started_at)) / 1000 : null;

    const audioNote = callout('info', null, 'The audio file is no longer stored on the server (removed by the retention policy), so playback is unavailable.');
    audioNote.classList.add('audio-note');
    audioNote.hidden = player.available;
    player.onUnavailable = () => { audioNote.hidden = false; };

    let metadata = null;
    if (t.metadata && typeof t.metadata === 'object' && Object.keys(t.metadata).length) {
      metadata = h('details', { class: 'metadata' }, h('summary', null, 'Metadata'), h('pre', { tabindex: '0' }, JSON.stringify(t.metadata, null, 2)));
    }

    return h('section', { class: 'card' },
      h('div', { class: 'viewer-title' }, h('h1', null, t.filename || t.id), statusBadge(t)),
      h('dl', { class: 'meta' },
        metaItem('Duration', fmtDuration(t.duration)),
        metaItem('Language', lang),
        metaItem('Task', t.task === 'translate' ? 'Translate → English' : 'Transcribe'),
        metaItem('Engine', engineLabel(t.engine)),
        metaItem('File size', fmtBytes(t.file_size)),
        metaItem('Created', timeEl(t.created_at)),
        t.completed_at && metaItem(t.status === 'failed' ? 'Failed' : 'Completed', [timeEl(t.completed_at), took != null && took >= 0 ? ` · took ${fmtDuration(took)}` : '']),
        t.webhook_status && metaItem('Webhook', webhookLabel(t.webhook_status)),
        metaItem('ID', h('span', { class: 'id-cell' }, h('code', null, t.id),
          h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Copy transcription ID', title: 'Copy ID', onclick: () => copyText(t.id, 'ID copied') }, icon('copy'))))),
      h('div', { class: 'toolbar' },
        done && h('button', { class: 'btn', type: 'button', onclick: () => copyText(fullText(t), 'Transcript copied') }, icon('copy'), 'Copy text'),
        done && h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Download transcript' },
          FORMATS.map((f) => h('a', {
            class: 'btn', href: `${API}transcriptions/${enc(t.id)}?format=${f}`, download: `${base}.${f}`,
            'aria-label': `Download ${f.toUpperCase()}`, title: `Download ${f.toUpperCase()}`,
          }, f === 'txt' ? [icon('download'), 'TXT'] : f.toUpperCase()))),
        h('button', { class: 'btn danger-ghost push', type: 'button', onclick: onDelete }, icon('trash'), 'Delete')),
      audioNote,
      metadata);
  }

  function webhookLabel(s) {
    if (s === 'delivered') return h('span', { class: 'badge ok' }, 'Delivered');
    if (s === 'pending') return h('span', { class: 'badge' }, 'Pending');
    if (String(s).startsWith('failed')) return h('span', { class: 'badge bad', title: s }, 'Failed' + (s.includes(':') ? ' · ' + s.split(':').slice(1).join(':') : ''));
    return s;
  }

  function fullText(t) {
    if (t.text) return t.text;
    return (t.segments || []).map((s) => String(s.text || '').trim()).join('\n');
  }

  function viewerBody(t, player) {
    if (t.status === 'failed') {
      return h('section', { class: 'card' }, callout('error', 'Transcription failed', t.error || 'No error message was recorded.'));
    }
    if (t.status !== 'completed') {
      const processing = t.status === 'processing';
      const title = (progress) => (processing ? `Transcribing${progress != null ? ` · ${progress}%` : '…'}` : 'Queued');
      const heading = h('h2', null, title(t.progress));
      const bar = processing ? h('progress', { max: '100', 'aria-label': 'Transcription progress' }) : null;
      const card = h('section', { class: 'card' }, h('div', { class: 'pending', role: 'status' },
        processing ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('clock', 'state-icon'),
        heading,
        bar,
        h('p', { class: 'muted' }, t.engine === 'worker' && !processing
          ? 'Waiting for a PC worker to pick this up. Make sure the worker is running (see Docs → PC worker). This page updates automatically.'
          : 'This page updates automatically — you can also leave and come back later.')));
      card.updateProgress = (progress) => {
        heading.textContent = title(progress);
        if (!bar) return;
        if (progress != null) bar.value = progress;
        else bar.removeAttribute('value'); // indeterminate
      };
      card.updateProgress(t.progress);
      return card;
    }
    return transcriptCard(t, player);
  }

  function transcriptCard(t, player) {
    const segs = Array.isArray(t.segments) ? t.segments.filter((s) => s && String(s.text || '').trim()) : [];
    if (!segs.length) {
      return h('section', { class: 'card' }, t.text
        ? h('p', { class: 'plain-text' }, t.text)
        : emptyState({ icon: 'wave', title: 'No speech found', text: 'The engine finished but returned no text for this file.' }));
    }

    const starts = segs.map((s) => Number(s.start) || 0);
    const ends = segs.map((s, i) => (s.end != null ? Number(s.end) : (starts[i + 1] != null ? starts[i + 1] : Infinity)));
    const lines = h('div', { class: 'lines' });
    const texts = [];
    segs.forEach((s, i) => {
      const text = String(s.text).trim();
      const x = h('p', { class: 'x' }, text);
      texts.push(text);
      lines.append(h('div', { class: 'line' },
        h('button', { class: 't', type: 'button', dataset: { i: String(i) }, disabled: !player.available, title: player.available ? 'Play from here' : null, 'aria-label': `Play from ${clock(starts[i])}` }, clock(starts[i])),
        x));
    });

    // Click a timestamp → seek and play (event delegation keeps long transcripts cheap).
    lines.addEventListener('click', (e) => {
      const btn = e.target.closest('button.t');
      if (btn && !btn.disabled) player.seek(starts[Number(btn.dataset.i)]);
    });
    const prevUnavailable = player.onUnavailable;
    player.onUnavailable = () => {
      if (prevUnavailable) prevUnavailable();
      lines.querySelectorAll('button.t').forEach((b) => { b.disabled = true; b.removeAttribute('title'); });
    };

    // Active line follows playback; auto-scroll unless the user scrolled recently.
    let active = -1;
    let userScrolledAt = 0;
    const markScroll = () => { userScrolledAt = Date.now(); };
    window.addEventListener('wheel', markScroll, { passive: true });
    window.addEventListener('touchmove', markScroll, { passive: true });
    player.onCleanup(() => {
      window.removeEventListener('wheel', markScroll);
      window.removeEventListener('touchmove', markScroll);
    });
    player.onTime = (now) => {
      let lo = 0, hi = starts.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (idx >= 0 && now >= ends[idx]) idx = -1;
      if (idx === active) return;
      if (active >= 0) lines.children[active].classList.remove('active');
      active = idx;
      if (idx < 0) return;
      const row = lines.children[idx];
      row.classList.add('active');
      if (!player.audio.paused && Date.now() - userScrolledAt > 4000) {
        const r = row.getBoundingClientRect();
        if (r.top < 80 || r.bottom > window.innerHeight - 100) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };

    // Find in transcript: hide non-matching lines and highlight matches.
    const find = h('input', { type: 'search', placeholder: 'Find in transcript', 'aria-label': 'Find in transcript', spellcheck: 'false' });
    const findCount = h('span', { class: 'find-count muted', 'aria-live': 'polite' });
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase();
      let hits = 0;
      Array.from(lines.children).forEach((row, i) => {
        const x = row.lastElementChild;
        const text = texts[i];
        const at = q ? text.toLowerCase().indexOf(q) : -1;
        row.hidden = !!q && at < 0;
        if (!q || at < 0) { x.textContent = text; return; }
        hits++;
        const parts = [];
        let from = 0;
        const lower = text.toLowerCase();
        for (let pos = at; pos >= 0; pos = lower.indexOf(q, from)) {
          parts.push(text.slice(from, pos), h('mark', null, text.slice(pos, pos + q.length)));
          from = pos + q.length;
        }
        parts.push(text.slice(from));
        x.replaceChildren(...parts.filter((part) => part !== ''));
      });
      findCount.textContent = q ? plural(hits, 'line') : '';
    });

    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, 'Transcript'), h('p', { class: 'muted' }, `${plural(segs.length, 'line')}` + (player.available ? ' · click a time to play from there' : ''))),
        h('div', { class: 'find' }, icon('search'), find, findCount)),
      lines);
  }

  /** Fixed bottom audio bar. Hidden automatically if the audio endpoint 404s (file deleted). */
  function createPlayer(id) {
    const audio = h('audio', { controls: true, preload: 'metadata', src: `${API}transcriptions/${enc(id)}/audio` });
    const speed = h('select', { class: 'compact', 'aria-label': 'Playback speed', title: 'Playback speed' },
      [0.75, 1, 1.25, 1.5, 2].map((r) => h('option', { value: String(r), selected: r === 1 }, r + '×')));
    speed.addEventListener('change', () => { audio.playbackRate = Number(speed.value); });
    const el = h('div', { class: 'player', role: 'region', 'aria-label': 'Audio player' }, h('div', { class: 'player-inner' }, audio, speed));
    const cleanups = [];
    const player = {
      el, audio,
      available: true,
      onTime: null,
      onUnavailable: null,
      seek(sec) {
        if (!player.available) return;
        audio.currentTime = sec;
        const p = audio.play();
        if (p && p.catch) p.catch(() => {});
      },
      onCleanup(fn) { cleanups.push(fn); },
      destroy() {
        cleanups.forEach((fn) => fn());
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        el.remove();
        document.body.classList.remove('has-player');
      },
    };
    audio.addEventListener('timeupdate', () => { if (player.onTime) player.onTime(audio.currentTime); });
    audio.addEventListener('error', () => {
      if (!audio.getAttribute('src')) return;
      player.available = false;
      el.hidden = true;
      document.body.classList.remove('has-player');
      if (player.onUnavailable) player.onUnavailable();
    });
    document.body.classList.add('has-player');
    return player;
  }

  // ================================================================ view: account

  function viewAccount() {
    const u = state.user;
    const currentPw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const newPw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    const confirmPw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    const err = formError();
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
    const form = h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        if (newPw.value !== confirmPw.value) return setError(err, 'The new passwords do not match.');
        withBusy(save, async () => {
          clearError(err);
          try {
            await api('password', { method: 'POST', body: { current_password: currentPw.value, new_password: newPw.value } });
            form.reset();
            toast('Password changed', 'success');
          } catch (ex) {
            if (ex.status !== 401) setError(err, ex.message);
          }
        });
      },
    },
    h('div', { class: 'card-head' }, h('h2', null, 'Change password')),
    h('div', { class: 'form-grid' },
      field('Current password', currentPw, { class: 'span-all' }),
      field('New password', newPw, { hint: 'At least 8 characters.' }),
      field('Confirm new password', confirmPw)),
    err,
    h('div', { class: 'form-actions' }, save));

    const signOut = h('button', { class: 'btn', type: 'button', onclick: () => withBusy(signOut, logout) }, icon('logout'), 'Sign out');

    setView(pageHead('Account', 'Your profile and sign-in settings.'),
      h('section', { class: 'card' }, h('div', { class: 'profile' }, avatar(u.name || u.email, 'lg'),
        h('div', { class: 'grow' },
          h('div', { class: 'title-row' }, h('h2', null, u.name || u.email), u.is_admin && h('span', { class: 'badge accent' }, 'Administrator')),
          h('p', { class: 'muted' }, u.email),
          h('p', { class: 'muted small' }, 'Member since ', timeEl(u.created_at))),
        signOut)),
      form,
      h('p', { class: 'app-version' }, APP_NAME + (cfg().version ? ' v' + cfg().version : '')));
  }

  async function logout() {
    uploads.cancelAll();
    try {
      await api('logout', { method: 'POST', allow401: true });
    } catch (e) {
      if (e.status !== 401) { toastError(e); return; }
    }
    state.user = null;
    state.csrf = '';
    shell = null;
    toast('Signed out', 'info');
    navigate('/login', true);
  }

  // ================================================================ view: admin users

  async function viewAdminUsers(ctx) {
    const list = h('div', { class: 'rows' }, skeleton('row', 3));
    const count = h('span', { class: 'count' });

    const name = h('input', { type: 'text', required: true, maxlength: '190', autocomplete: 'off' });
    const email = h('input', { type: 'email', required: true, autocomplete: 'off', spellcheck: 'false' });
    const pass = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
    const admin = h('input', { type: 'checkbox' });
    const err = formError();
    const create = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Create user');
    const form = h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(create, async () => {
          clearError(err);
          try {
            await api('users', { method: 'POST', body: { name: name.value.trim(), email: email.value.trim(), password: pass.value, is_admin: admin.checked } });
            toast(`Account created for ${email.value.trim()}`, 'success');
            form.reset();
            load();
          } catch (ex) {
            if (ex.status !== 401) setError(err, ex.message);
          }
        });
      },
    },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Add user'), h('p', { class: 'muted' }, 'Share the password with them securely; they can change it under Account.'))),
    h('div', { class: 'form-grid' },
      field('Name', name), field('Email', email), field('Initial password', pass, { hint: 'At least 8 characters.' })),
    err,
    h('div', { class: 'form-actions' }, h('label', { class: 'check push' }, admin, 'Administrator'), create));

    setView(pageHead('Users', 'Everyone who can sign in to this dashboard.'),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'All users ', count)), list),
      form);

    async function load() {
      const { data } = await api('users');
      if (!ctx.alive) return;
      const users = data || [];
      count.textContent = `(${users.length})`;
      list.replaceChildren(...users.map(userRow));
    }

    function userRow(u) {
      const self = state.user && u.id === state.user.id;
      const adminToggle = h('input', { type: 'checkbox', role: 'switch', checked: !!u.is_admin, disabled: self, 'aria-label': `Administrator: ${u.name || u.email}` });
      adminToggle.addEventListener('change', async () => {
        adminToggle.disabled = true;
        try {
          await api('users/' + enc(u.id), { method: 'PATCH', body: { is_admin: adminToggle.checked } });
          u.is_admin = adminToggle.checked;
          toast(`${u.name || u.email} is ${u.is_admin ? 'now' : 'no longer'} an administrator`, 'success');
        } catch (e) {
          adminToggle.checked = !!u.is_admin;
          toastError(e);
        }
        adminToggle.disabled = self;
      });
      const disableBtn = h('button', { class: ['btn', 'small', !u.disabled && 'danger-ghost'], type: 'button', disabled: self, title: self ? 'You cannot disable your own account' : null, onclick: () => toggleDisabled(u) }, u.disabled ? 'Enable' : 'Disable');
      return h('div', { class: ['row-item', u.disabled && 'dim'] },
        avatar(u.name || u.email),
        h('div', { class: 'ri-main' },
          h('div', { class: 'ri-title' }, u.name || u.email, self && h('span', { class: 'badge' }, 'You'), u.disabled && h('span', { class: 'badge bad' }, 'Disabled')),
          h('div', { class: 'ri-sub' }, u.email, ' · joined ', timeEl(u.created_at), ' · ',
            u.last_login_at ? ['last sign-in ', timeEl(u.last_login_at)] : 'never signed in')),
        h('div', { class: 'ri-actions' },
          h('label', { class: 'switch', title: self ? 'You cannot change your own admin rights' : null }, adminToggle, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), 'Admin'),
          h('button', { class: 'btn small', type: 'button', onclick: () => setPasswordDialog(u) }, 'Set password'),
          disableBtn));
    }

    async function toggleDisabled(u) {
      if (!u.disabled) {
        const ok = await confirmDialog({
          title: 'Disable user?',
          message: [u.name || u.email, ' will not be able to sign in until re-enabled. Their projects and API keys stay as they are.'],
          confirmLabel: 'Disable',
          danger: true,
        });
        if (!ok) return;
      }
      try {
        await api('users/' + enc(u.id), { method: 'PATCH', body: { disabled: !u.disabled } });
        toast(`${u.name || u.email} ${u.disabled ? 'enabled' : 'disabled'}`, 'success');
        if (ctx.alive) load();
      } catch (e) { toastError(e); }
    }

    function setPasswordDialog(u) {
      const pw = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
      formDialog({
        title: 'Set password',
        submitLabel: 'Set password',
        body: [h('p', { class: 'muted' }, 'New password for ', h('strong', null, u.email), '.'), field('New password', pw, { hint: 'At least 8 characters.' })],
        onSubmit: async () => {
          await api('users/' + enc(u.id), { method: 'PATCH', body: { password: pw.value } });
          toast('Password updated', 'success');
        },
      });
    }

    await load();
  }

  // ================================================================ boot

  let routerStarted = false;

  async function boot() {
    try {
      await loadMe();
    } catch (e) {
      // Server unreachable or broken: offer a retry instead of a blank page.
      setView(h('div', { class: 'auth' }, h('div', { class: 'card auth-card' },
        errorState(e, () => { setView(loadingState()); boot(); }))));
      return;
    }
    if (!routerStarted) {
      routerStarted = true;
      window.addEventListener('hashchange', onRoute);
    }
    await onRoute();
    booted = true;
  }

  function init() {
    document.getElementById('skip').addEventListener('click', () => {
      const target = $view.querySelector('h1') || $view;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus();
    });
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
