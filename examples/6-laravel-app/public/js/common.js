/* Small helpers shared by the App page and the Backend tester. No libraries. */
window.TD = (function () {
  'use strict';

  function csrf() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  /** el('li', {class: 'x', text: 'hi', on: {click: fn}, attrs: {title: 't'}, dataset: {id: 1}}, child, ...) */
  function el(tag, props) {
    var node = document.createElement(tag);
    props = props || {};
    if (props.class) node.className = props.class;
    if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
    if (props.attrs) Object.keys(props.attrs).forEach(function (k) {
      if (props.attrs[k] !== null && props.attrs[k] !== undefined && props.attrs[k] !== false) node.setAttribute(k, props.attrs[k]);
    });
    if (props.dataset) Object.keys(props.dataset).forEach(function (k) { node.dataset[k] = props.dataset[k]; });
    if (props.on) Object.keys(props.on).forEach(function (k) { node.addEventListener(k, props.on[k]); });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /** Best message for a failed call to this Laravel app. */
  function errorMessage(status, data) {
    if (status === 419) return 'The page expired. Please reload the page.';
    if (data && data.errors) {
      var keys = Object.keys(data.errors);
      if (keys.length && data.errors[keys[0]] && data.errors[keys[0]][0]) return data.errors[keys[0]][0];
    }
    if (data && data.error && data.error.message) return data.error.message;
    if (data && typeof data.message === 'string' && data.message) return data.message;
    if (!status) return 'Network error. Is "php artisan serve" still running?';
    return 'HTTP ' + status;
  }

  /** fetch() to this app with CSRF + JSON. Throws Error(message) with .status and .data when not 2xx. */
  function api(method, url, body) {
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': csrf(), 'X-Requested-With': 'XMLHttpRequest' }
    };
    if (body instanceof FormData) {
      opts.body = body;
    } else if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(errorMessage(res.status, data));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error(errorMessage(0, null));
      err.status = 0;
      throw err;
    });
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** 75.3 -> "01:15", 3725 -> "1:02:05" */
  function clock(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? h + ':' + pad(m) + ':' + pad(r) : pad(m) + ':' + pad(r);
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function dateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function timeOnly(iso) {
    var d = iso ? new Date(iso) : new Date();
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function storage(kind) {
    try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
  }

  // ----- light / dark toggle (remembered in this browser) -----
  function initTheme() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function current() {
      var t = document.documentElement.getAttribute('data-theme');
      if (t) return t;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function label() {
      var dark = current() === 'dark';
      btn.textContent = dark ? '☀' : '☾';
      btn.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme');
      btn.title = dark ? 'Light theme' : 'Dark theme';
    }
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      var ls = storage('local');
      try { if (ls) ls.setItem('td-theme', next); } catch (e) { /* private mode */ }
      label();
    });
    label();
  }
  document.addEventListener('DOMContentLoaded', initTheme);

  return { csrf: csrf, el: el, api: api, errorMessage: errorMessage, clock: clock, bytes: bytes,
    dateTime: dateTime, timeOnly: timeOnly, storage: storage };
})();
