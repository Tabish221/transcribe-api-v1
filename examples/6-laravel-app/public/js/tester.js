/* Backend tester: every card posts to /tester-api/{action}; Laravel calls the Transcribe API. */
(function () {
  'use strict';
  var TD = window.TD, el = TD.el;
  var root = document.getElementById('tester-root');
  if (!root) return;

  var HISTORY_KEY = 'td-tester-history';
  var HISTORY_MAX = 25;
  var maxBytes = Number(root.dataset.maxBytes) || 0;
  var forms = {};
  Array.prototype.forEach.call(document.querySelectorAll('form.action-card'), function (f) { forms[f.dataset.action] = f; });

  // ----- one call ----------------------------------------------------------------------------
  /** POSTs to /tester-api/{action}. Always resolves with an entry {t, action, result}. */
  function call(action, formData) {
    var started = Date.now();
    return fetch('/tester-api/' + action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': TD.csrf(), 'X-Requested-With': 'XMLHttpRequest' },
      body: formData
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (res.ok && data && data.request && data.response) return data;
        // Laravel itself answered with an error (419 page expired, 500 ...): show that instead.
        return synthetic(action, res.status, data || text, TD.errorMessage(res.status, data), Date.now() - started);
      });
    }, function () {
      return synthetic(action, 0, null, TD.errorMessage(0, null), Date.now() - started);
    }).then(function (result) {
      var entry = { t: new Date().toISOString(), action: action, result: result };
      addHistory(entry);
      if (forms[action]) renderResult(forms[action], entry);
      return entry;
    });
  }

  function synthetic(action, status, body, message, ms) {
    return {
      action: action, ok: false,
      request: { method: 'POST', url: '/tester-api/' + action + ' (this Laravel app)', headers: {}, fields: {} },
      response: { status: status, headers: {}, body: body },
      error: { code: status ? 'laravel_error' : 'network_error', message: message },
      duration_ms: ms
    };
  }

  function fd(fields) {
    var f = new FormData();
    Object.keys(fields || {}).forEach(function (k) { f.append(k, fields[k]); });
    return f;
  }

  // ----- show a result: request | response ------------------------------------------------------
  function pretty(body) {
    if (body === null || body === undefined) return '(empty)';
    if (typeof body === 'string') {
      var s = body.trim();
      if (s.charAt(0) === '{' || s.charAt(0) === '[') {
        try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { /* not JSON */ }
      }
      return body === '' ? '(empty)' : body;
    }
    return JSON.stringify(body, null, 2);
  }

  function statusClass(status) {
    return 's' + (status ? String(status).charAt(0) : '0');
  }

  function requestText(req) {
    var lines = [(req.method || '') + ' ' + (req.url || '')];
    var headers = req.headers || {};
    Object.keys(headers).forEach(function (k) { lines.push(k + ': ' + headers[k]); });
    var fields = req.fields || {};
    var keys = Object.keys(fields);
    if (keys.length) {
      lines.push('');
      keys.forEach(function (k) {
        var v = fields[k];
        lines.push(k + ' = ' + (typeof v === 'string' ? v : JSON.stringify(v)));
      });
    }
    if (req.body) {
      lines.push('');
      lines.push(JSON.stringify(req.body, null, 2));
    }
    return lines.join('\n');
  }

  function renderResult(form, entry) {
    var r = entry.result;
    var box = form.querySelector('.result');
    box.textContent = '';
    box.hidden = false;

    var reqPane = el('div', { class: 'pane' },
      el('div', { class: 'pane-head' }, el('h4', { text: 'Request' }), el('span', { class: 'ms', text: TD.timeOnly(entry.t) })),
      el('pre', { text: requestText(r.request || {}) }));

    var res = r.response || {};
    var headerLines = Object.keys(res.headers || {}).map(function (k) { return k + ': ' + res.headers[k]; });
    var resPane = el('div', { class: 'pane' },
      el('div', { class: 'pane-head' },
        el('h4', { text: 'Response' }),
        // Status 0: "no answer" = network error; "not sent" = stopped before the call (for example a validation error).
        el('span', { class: 'badge ' + statusClass(res.status),
          text: res.status ? 'HTTP ' + res.status : (r.error && r.error.code === 'network_error' ? 'no answer' : 'not sent') }),
        el('span', { class: 'ms', text: (r.duration_ms || 0) + ' ms' })),
      r.error ? el('p', { class: 'err-line', text: (r.error.code ? r.error.code + ': ' : '') + (r.error.message || '') }) : null,
      el('pre', { text: (headerLines.length ? headerLines.join('\n') + '\n\n' : '') + pretty(res.body) }));

    box.appendChild(reqPane);
    box.appendChild(resPane);
  }

  // ----- action cards ----------------------------------------------------------------------------
  Object.keys(forms).forEach(function (action) {
    var form = forms[action];
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      var submitter = e.submitter;
      if (submitter && submitter.name) data.set(submitter.name, submitter.value);
      if (action === 'upload') {
        var file = form.querySelector('input[type=file]').files[0];
        if (maxBytes && file && file.size > maxBytes) {
          window.alert('The file is too big. Max size: ' + root.dataset.maxHuman);
          return;
        }
      }
      if (action === 'delete' && !window.confirm('Delete ' + data.get('id') + ' on the API?')) return;
      send(form, action, data, submitter);
    });
  });

  function send(form, action, data, submitter) {
    var buttons = form.querySelectorAll('button[type=submit]');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    var btn = submitter || buttons[0];
    var label = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Sending…';
    return call(action, data).then(function (entry) {
      afterCall(entry);
      return entry;
    }).then(function (entry) {
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
      if (btn) btn.textContent = label;
      return entry;
    });
  }

  /** Puts the newest job id into the ID fields, and refreshes the webhook table after a simulation. */
  function afterCall(entry) {
    var body = entry.result && entry.result.response && entry.result.response.body;
    if (entry.action === 'upload' && body && body.id) setIds(body.id, true);
    if (entry.action === 'list' && body && body.data && body.data[0]) setIds(body.data[0].id, false);
    if (entry.action === 'webhook-simulate') loadLogs();
  }

  function setIds(id, overwrite) {
    Array.prototype.forEach.call(document.querySelectorAll('.id-input'), function (input) {
      if (overwrite || !input.value) input.value = id;
    });
  }

  // ----- history (sessionStorage = this browser tab only) -----------------------------------------
  var histList = document.getElementById('hist'), histEmpty = document.getElementById('hist-empty');

  function readHistory() {
    var ss = TD.storage('session');
    try { return JSON.parse((ss && ss.getItem(HISTORY_KEY)) || '[]') || []; } catch (e) { return []; }
  }

  function addHistory(entry) {
    var items = readHistory();
    var copy = entry;
    if (JSON.stringify(entry).length > 60000) { // keep sessionStorage small
      copy = JSON.parse(JSON.stringify(entry));
      copy.result.response.body = '(too big to keep in the history: ' + JSON.stringify(entry.result.response.body).length + ' characters)';
    }
    items.unshift(copy);
    items = items.slice(0, HISTORY_MAX);
    var ss = TD.storage('session');
    try { if (ss) ss.setItem(HISTORY_KEY, JSON.stringify(items)); } catch (e) { /* storage full or blocked */ }
    renderHistory(items);
  }

  function renderHistory(items) {
    items = items || readHistory();
    histList.textContent = '';
    histEmpty.hidden = items.length > 0;
    items.forEach(function (entry) {
      var r = entry.result || {}, status = r.response ? r.response.status : 0;
      histList.appendChild(el('li', {}, el('button', {
        attrs: { type: 'button' },
        on: { click: function () {
          var form = forms[entry.action];
          if (!form) return;
          renderResult(form, entry);
          form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } }
      },
        el('span', { class: 'ms', text: TD.timeOnly(entry.t) }),
        el('span', { class: 'h-action', text: entry.action }),
        el('span', { class: 'badge ' + statusClass(status), text: status || '—' }),
        el('span', { class: 'ms', text: (r.duration_ms || 0) + ' ms' }))));
    });
  }

  document.getElementById('hist-clear').addEventListener('click', function () {
    var ss = TD.storage('session');
    try { if (ss) ss.removeItem(HISTORY_KEY); } catch (e) { /* ignore */ }
    renderHistory([]);
  });

  // ----- webhooks received (refresh every 3 s) ----------------------------------------------------
  var whBody = document.getElementById('wh-body'), whEmpty = document.getElementById('wh-empty');
  var whUpdated = document.getElementById('wh-updated');
  var logsTimer = null, lastLogs = [];

  function loadLogs() {
    clearTimeout(logsTimer);
    return TD.api('GET', '/tester-api/webhook-logs').then(function (res) {
      lastLogs = (res && res.data) || [];
      renderLogs(lastLogs);
      whUpdated.textContent = 'updated ' + TD.timeOnly();
      return lastLogs;
    }).catch(function (err) {
      whUpdated.textContent = 'cannot refresh: ' + err.message;
      return lastLogs;
    }).then(function (logs) {
      clearTimeout(logsTimer);
      logsTimer = setTimeout(tick, 3000);
      return logs;
    });
  }

  function tick() {
    if (document.hidden) { logsTimer = setTimeout(tick, 3000); return; }
    loadLogs();
  }

  function renderLogs(logs) {
    whBody.textContent = '';
    whEmpty.hidden = logs.length > 0;
    logs.forEach(function (log) {
      var title = (log.note || '') + (log.user_agent ? ' · ' + log.user_agent : '');
      whBody.appendChild(el('tr', { attrs: { title: title } },
        el('td', { text: TD.timeOnly(log.received_at) }),
        el('td', { text: (log.event || '—').replace('transcription.', '') }),
        el('td', { class: 'mono', text: log.remote_id || '—' }),
        el('td', { class: log.signature_valid ? 'sig-ok' : 'sig-bad', text: log.signature_valid ? '✓' : '✗',
          attrs: { 'aria-label': log.signature_valid ? 'valid signature' : 'bad signature' } }),
        el('td', {}, el('span', { class: 'badge ' + statusClass(log.http_status_returned), text: String(log.http_status_returned) }))));
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-simulate]'), function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      var cardButton = forms['webhook-simulate'].querySelector('button[value="' + b.dataset.simulate + '"]');
      send(forms['webhook-simulate'], 'webhook-simulate', fd({ mode: b.dataset.simulate }), cardButton)
        .then(function () { b.disabled = false; });
    });
  });

  // ----- run all checks ----------------------------------------------------------------------
  var ra = {
    btn: document.getElementById('ra-run'), file: document.getElementById('ra-file'),
    engine: document.getElementById('ra-engine'), del: document.getElementById('ra-delete'),
    list: document.getElementById('ra-list'), summary: document.getElementById('ra-summary')
  };
  var STEPS = [
    ['health', 'API is up (health)'],
    ['list', 'API key works (list)'],
    ['upload', 'Upload the MP3'],
    ['wait', 'Transcription finished'],
    ['srt', 'Download SRT'],
    ['webhook', 'Webhook arrived with a valid signature'],
    ['delete', 'Delete the test job']
  ];
  var rows = {};

  function setStep(key, mark, detail) {
    var row = rows[key];
    var labels = { pass: 'PASS', fail: 'FAIL', run: '…', wait: 'WAIT', skip: 'SKIP' };
    row.mark.className = 'mark ' + mark;
    row.mark.textContent = labels[mark];
    row.detail.textContent = detail || '';
    row.state = mark;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function okStatus(entry) { return entry.result.response.status; }

  async function runAll() {
    var file = ra.file.files[0];
    ra.list.textContent = '';
    ra.list.hidden = false;
    ra.summary.textContent = '';
    ra.summary.className = 'summary';
    STEPS.forEach(function (s) {
      var mark = el('span', { class: 'mark wait', text: 'WAIT' });
      var detail = el('span', { class: 'c-detail' });
      ra.list.appendChild(el('li', {}, mark, el('span', {}, el('span', { class: 'c-name', text: s[1] }), el('br'), detail)));
      rows[s[0]] = { mark: mark, detail: detail, state: 'wait' };
    });
    ra.btn.disabled = true;
    ra.btn.textContent = 'Running…';
    var id = null;

    try {
      // 1. health
      setStep('health', 'run');
      var h = await call('health', fd({}));
      var hb = h.result.response.body || {};
      if (okStatus(h) === 200 && hb.ok === true) {
        var engines = Object.keys(hb.engines || {}).filter(function (k) { return hb.engines[k]; });
        setStep('health', 'pass', 'version ' + hb.version + ', engines on: ' + (engines.join(', ') || 'none'));
      } else {
        setStep('health', 'fail', h.result.error ? h.result.error.message : 'HTTP ' + okStatus(h));
        return;
      }

      // 2. list
      setStep('list', 'run');
      var l = await call('list', fd({ limit: 5 }));
      var lb = l.result.response.body || {};
      if (okStatus(l) === 200 && lb.object === 'list') setStep('list', 'pass', lb.total + ' job(s) in this project');
      else { setStep('list', 'fail', l.result.error ? l.result.error.message : 'HTTP ' + okStatus(l)); return; }

      // 3. upload
      if (!file) { setStep('upload', 'fail', 'Choose an MP3 file above first (for example sample/clip.mp3).'); return; }
      setStep('upload', 'run', 'Uploading ' + file.name + ' (' + TD.bytes(file.size) + ')…');
      var u = await call('upload', fd({ file: file, engine: ra.engine.value, webhook: '1', metadata: '{"source":"tester-run-all"}' }));
      var ub = u.result.response.body || {};
      if ((okStatus(u) === 202 || okStatus(u) === 200) && ub.id) {
        id = ub.id;
        setIds(id, true);
        setStep('upload', 'pass', 'HTTP ' + okStatus(u) + ', id ' + id + ', status ' + ub.status);
      } else { setStep('upload', 'fail', u.result.error ? u.result.error.message : 'HTTP ' + okStatus(u)); return; }

      // 4. poll until completed / failed
      var deadline = Date.now() + 30 * 60 * 1000, job = ub, started = Date.now();
      setStep('wait', 'run', 'status ' + job.status);
      while (job.status !== 'completed' && job.status !== 'failed') {
        if (Date.now() > deadline) { setStep('wait', 'fail', 'Still ' + job.status + ' after 30 minutes. Is the worker running?'); return; }
        await sleep(5000);
        var g = await call('get', fd({ id: id }));
        if (okStatus(g) === 200 && g.result.response.body) job = g.result.response.body;
        else if (okStatus(g) === 404 || okStatus(g) === 401) {
          // The job was deleted, or the key no longer works: waiting longer will not help.
          setStep('wait', 'fail', g.result.error ? g.result.error.message : 'HTTP ' + okStatus(g));
          return;
        }
        var secs = Math.round((Date.now() - started) / 1000);
        var info = job.status === 'queued' ? 'queued (waiting for the worker)'
          : job.status + (job.progress !== null && job.progress !== undefined ? ' ' + job.progress + '%' : '');
        setStep('wait', 'run', info + ' · ' + secs + ' s');
      }
      if (job.status === 'completed') {
        var segs = (job.segments || []).length;
        setStep('wait', 'pass', 'completed in ' + Math.round((Date.now() - started) / 1000) + ' s, ' + segs + ' segments, ' + (job.text || '').length + ' characters');
      } else { setStep('wait', 'fail', 'failed: ' + (job.error || 'no error message')); }

      // 5. srt
      if (job.status === 'completed') {
        setStep('srt', 'run');
        var s = await call('format', fd({ id: id, format: 'srt' }));
        var sb = s.result.response.body;
        if (okStatus(s) === 200 && typeof sb === 'string' && sb.indexOf('-->') !== -1) {
          setStep('srt', 'pass', sb.split('-->').length - 1 + ' subtitle blocks');
        } else { setStep('srt', 'fail', s.result.error ? s.result.error.message : 'HTTP ' + okStatus(s)); }
      } else { setStep('srt', 'skip', 'The job did not complete.'); }

      // 6. webhook (the API calls /webhooks/transcribe when the job is done)
      setStep('webhook', 'run', 'Waiting up to 30 s…');
      var found = null, until = Date.now() + 30000;
      while (!found && Date.now() < until) {
        var logs = await loadLogs();
        found = logs.filter(function (x) { return x.remote_id === id; })[0] || null;
        if (!found) await sleep(2000);
      }
      if (found && found.signature_valid && found.http_status_returned === 200) {
        setStep('webhook', 'pass', (found.event || '') + ' at ' + TD.timeOnly(found.received_at) + ', signature ✓');
      } else if (found) {
        setStep('webhook', 'fail', 'Received, but signature ' + (found.signature_valid ? '✓' : '✗') + ' and HTTP ' + found.http_status_returned + '. Check TRANSCRIBE_WEBHOOK_SECRET.');
      } else {
        setStep('webhook', 'fail', 'Not received. Can the API reach this app? Look at "webhook_status" in the get answer.');
      }
    } finally {
      // 7. delete (also after a failure, so no test job is left behind)
      if (id && ra.del.checked) {
        setStep('delete', 'run');
        var d = await call('delete', fd({ id: id }));
        if (okStatus(d) === 200) setStep('delete', 'pass', id + ' deleted');
        else if (okStatus(d) === 404) setStep('delete', 'skip', id + ' is already gone from the API.');
        else setStep('delete', 'fail', d.result.error ? d.result.error.message : 'HTTP ' + okStatus(d));
      } else if (rows.delete.state === 'wait') {
        setStep('delete', 'skip', id ? 'Kept (box not checked). ID: ' + id : 'Nothing to delete.');
      }
      Object.keys(rows).forEach(function (k) { if (rows[k].state === 'wait') setStep(k, 'skip', 'Not run (an earlier step failed).'); });
      var failed = Object.keys(rows).filter(function (k) { return rows[k].state === 'fail'; }).length;
      var passed = Object.keys(rows).filter(function (k) { return rows[k].state === 'pass'; }).length;
      ra.summary.textContent = failed ? failed + ' check(s) failed, ' + passed + ' passed.' : 'All ' + passed + ' checks passed.';
      ra.summary.className = 'summary ' + (failed ? 'fail' : 'pass');
      ra.btn.disabled = false;
      ra.btn.textContent = 'Run all checks';
    }
  }

  ra.btn.addEventListener('click', function () {
    runAll().catch(function (err) {
      ra.summary.textContent = 'Error: ' + err.message;
      ra.summary.className = 'summary fail';
      ra.btn.disabled = false;
      ra.btn.textContent = 'Run all checks';
    });
  });

  renderHistory();
  loadLogs();
})();
