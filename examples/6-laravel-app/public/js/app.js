/* App page: upload an MP3, follow the job, read and play the transcript. */
(function () {
  'use strict';
  var TD = window.TD, el = TD.el;
  var root = document.getElementById('app-root');
  if (!root) return;

  var POLL_MS = 4000;
  var maxBytes = Number(root.dataset.maxBytes) || 0;
  var maxHuman = root.dataset.maxHuman || '';
  var $ = function (id) { return document.getElementById(id); };

  var ui = {
    drop: $('dropzone'), file: $('file-input'), picked: $('picked'), engine: $('engine'), language: $('language'),
    uploadBtn: $('upload-btn'), progress: $('upload-progress'), uploadMsg: $('upload-msg'),
    list: $('list'), listEmpty: $('list-empty'), listMsg: $('list-msg'), refresh: $('refresh-list'),
    vEmpty: $('viewer-empty'), vBody: $('viewer-body'), vTitle: $('v-title'), vBadge: $('v-badge'), vMeta: $('v-meta'),
    vProgress: $('v-progress'), vError: $('v-error'), audio: $('v-audio'), copy: $('v-copy'), srt: $('v-srt'),
    del: $('v-delete'), vMsg: $('v-msg'), vHint: $('v-hint'), lines: $('v-lines'), text: $('v-text')
  };

  var state = {
    file: null,
    items: [],          // local list (no text/segments)
    selectedId: null,
    detail: null,       // selected item with text + segments
    objectUrls: {},     // local id -> blob: URL of a file uploaded in this tab
    linesKey: '',       // what is drawn in the lines list now
    activeLine: -1,
    pollTimer: null,
    busy: false
  };

  // ----- choose a file ---------------------------------------------------------------------
  function pick(file) {
    ui.uploadMsg.textContent = '';
    ui.uploadMsg.className = 'msg';
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) {
      return setUploadMsg('Please choose an MP3 file.', true);
    }
    if (maxBytes && file.size > maxBytes) {
      return setUploadMsg('The file is too big (' + TD.bytes(file.size) + '). Max size: ' + maxHuman + '.', true);
    }
    state.file = file;
    ui.picked.textContent = file.name + ' · ' + TD.bytes(file.size);
    ui.uploadBtn.disabled = state.busy;
  }

  ui.file.addEventListener('change', function () { pick(ui.file.files[0]); });
  ['dragenter', 'dragover'].forEach(function (type) {
    ui.drop.addEventListener(type, function (e) { e.preventDefault(); ui.drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    ui.drop.addEventListener(type, function (e) { e.preventDefault(); ui.drop.classList.remove('over'); });
  });
  ui.drop.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) pick(files[0]);
  });

  function setUploadMsg(text, isError) {
    ui.uploadMsg.textContent = text;
    ui.uploadMsg.className = 'msg' + (isError ? ' error' : ' ok');
  }

  function setBar(box, percent, label, indeterminate) {
    box.hidden = false;
    box.classList.toggle('indeterminate', !!indeterminate);
    box.querySelector('.bar').style.width = indeterminate ? '' : Math.max(0, Math.min(100, percent)) + '%';
    box.querySelector('.label').textContent = label;
  }

  // ----- upload (XMLHttpRequest, for the progress bar) ---------------------------------------
  ui.uploadBtn.addEventListener('click', function () {
    if (!state.file || state.busy) return;
    var file = state.file;
    var form = new FormData();
    form.append('file', file);
    form.append('engine', ui.engine.value);
    form.append('language', ui.language.value);

    state.busy = true;
    ui.uploadBtn.disabled = true;
    setUploadMsg('', false);
    setBar(ui.progress, 0, 'Uploading… 0%');

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/app-api/transcriptions');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.setRequestHeader('X-CSRF-TOKEN', TD.csrf());
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        var p = Math.round(e.loaded / e.total * 100);
        setBar(ui.progress, p, 'Uploading… ' + p + '%');
      }
    };
    xhr.upload.onload = function () { setBar(ui.progress, 100, 'Sending to the Transcribe API…', true); };
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      done();
      if (xhr.status === 201 && data && data.id) {
        state.objectUrls[data.id] = URL.createObjectURL(file);
        state.items = [data].concat(state.items.filter(function (i) { return i.id !== data.id; }));
        renderList();
        select(data.id, data);
        setUploadMsg('Uploaded. Status: ' + data.status + '. You can upload another file.', false);
        state.file = null;
        ui.file.value = '';
        ui.picked.textContent = '';
        ui.uploadBtn.disabled = true;
        schedulePoll();
      } else {
        setUploadMsg('Upload failed: ' + TD.errorMessage(xhr.status, data), true);
      }
    };
    xhr.onerror = function () { done(); setUploadMsg('Upload failed: ' + TD.errorMessage(0, null), true); };
    xhr.send(form);

    function done() {
      state.busy = false;
      ui.progress.hidden = true;
      ui.uploadBtn.disabled = !state.file;
    }
  });

  // ----- list ------------------------------------------------------------------------------
  function loadList() {
    ui.listMsg.textContent = '';
    return TD.api('GET', '/app-api/transcriptions').then(function (res) {
      state.items = (res && res.data) || [];
      renderList();
      schedulePoll();
    }).catch(function (err) { ui.listMsg.textContent = err.message; });
  }

  function badge(status) {
    return el('span', { class: 'badge ' + status, text: status });
  }

  function renderList() {
    ui.list.textContent = '';
    ui.listEmpty.hidden = state.items.length > 0;
    state.items.forEach(function (item) {
      var meta = [TD.dateTime(item.created_at)];
      if (item.duration) meta.push(TD.clock(item.duration));
      if (item.file_size) meta.push(TD.bytes(item.file_size));
      if (item.status === 'processing' && item.progress !== null) meta.push(item.progress + '%');
      var btn = el('button', {
        class: 't-item' + (item.id === state.selectedId ? ' selected' : ''),
        attrs: { type: 'button', 'aria-current': item.id === state.selectedId ? 'true' : null },
        on: { click: function () {
          select(item.id);
          // On a phone the viewer is below the list: bring it into view.
          if (window.matchMedia && window.matchMedia('(max-width: 1000px)').matches) {
            document.querySelector('.viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } }
      },
        el('span', { class: 'info' },
          el('div', { class: 'name', text: item.filename, attrs: { title: item.filename } }),
          el('div', { class: 'meta', text: meta.join(' · ') })),
        badge(item.status));
      ui.list.appendChild(el('li', {}, btn));
    });
  }

  function updateItem(detail) {
    var light = Object.assign({}, detail);
    delete light.text;
    delete light.segments;
    var found = false;
    state.items = state.items.map(function (i) {
      if (i.id === detail.id) { found = true; return light; }
      return i;
    });
    if (!found) state.items.unshift(light);
  }

  ui.refresh.addEventListener('click', loadList);

  // ----- polling: only while something is queued/processing ------------------------------------
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    var pending = state.items.some(function (i) { return !i.final; });
    if (pending) state.pollTimer = setTimeout(pollOnce, POLL_MS);
  }

  function pollOnce() {
    state.pollTimer = null;
    var pending = state.items.filter(function (i) { return !i.final; });
    // One request at a time: "php artisan serve" handles one request at a time.
    var chain = Promise.resolve();
    pending.forEach(function (item) {
      chain = chain.then(function () {
        return TD.api('GET', '/app-api/transcriptions/' + item.id).then(function (d) {
          updateItem(d);
          if (d.id === state.selectedId) renderViewer(d);
        }).catch(function (err) {
          if (err.status === 404) state.items = state.items.filter(function (i) { return i.id !== item.id; });
        });
      });
    });
    chain.then(function () { renderList(); schedulePoll(); });
  }

  // ----- viewer ----------------------------------------------------------------------------
  function select(id, known) {
    state.selectedId = id;
    ui.vMsg.textContent = '';
    renderList();
    if (known) renderViewer(known);
    return TD.api('GET', '/app-api/transcriptions/' + id).then(function (d) {
      if (state.selectedId !== id) return;
      updateItem(d);
      renderList();
      renderViewer(d);
    }).catch(function (err) {
      ui.vMsg.textContent = err.message;
      ui.vMsg.className = 'msg error';
    });
  }

  function renderViewer(d) {
    state.detail = d;
    ui.vEmpty.hidden = true;
    ui.vBody.hidden = false;
    ui.vTitle.textContent = d.filename;
    ui.vBadge.className = 'badge ' + d.status;
    ui.vBadge.textContent = d.status;

    var meta = [d.engine === 'cloud' ? 'Cloud' : 'Worker'];
    if (d.language) meta.push('language: ' + d.language);
    if (d.duration) meta.push(TD.clock(d.duration));
    meta.push(TD.dateTime(d.created_at));
    if (d.webhook_received_at) meta.push('webhook received ✓');
    meta.push('API id: ' + d.remote_id);
    ui.vMeta.textContent = meta.join(' · ');

    if (d.status === 'queued') {
      setBar(ui.vProgress, 0, 'Waiting for the worker…', true);
    } else if (d.status === 'processing') {
      if (d.progress === null || d.progress === undefined) setBar(ui.vProgress, 0, 'Processing…', true);
      else setBar(ui.vProgress, d.progress, 'Processing… ' + d.progress + '%');
    } else {
      ui.vProgress.hidden = true;
    }

    var errText = d.error || (d.sync_error && !d.final ? 'Cannot refresh now: ' + d.sync_error : '');
    ui.vError.hidden = !errText;
    ui.vError.textContent = errText;

    // Audio: the file from this tab (blob: URL) or the copy kept on the server. Hidden when neither exists.
    var src = state.objectUrls[d.id] || d.audio_url || '';
    if (ui.audio.dataset.forId !== String(d.id) || (!src && !ui.audio.hidden)) {
      ui.audio.pause();
      ui.audio.dataset.forId = String(d.id);
      state.activeLine = -1;
      if (src) {
        ui.audio.src = src;
        ui.audio.hidden = false;
      } else {
        ui.audio.removeAttribute('src');
        ui.audio.load();
        ui.audio.hidden = true;
      }
    }

    var completed = d.status === 'completed';
    ui.copy.disabled = !(completed && d.text);
    ui.srt.disabled = !completed;
    renderLines(d);
  }

  function renderLines(d) {
    var segments = Array.isArray(d.segments) ? d.segments : [];
    var key = d.id + ':' + d.status + ':' + segments.length + ':' + (d.text ? d.text.length : 0);
    if (key === state.linesKey) return; // keep the list (and the highlight) while polling
    state.linesKey = key;
    state.activeLine = -1;
    ui.lines.textContent = '';
    ui.lines.hidden = segments.length === 0;
    ui.text.hidden = true;

    if (segments.length) {
      segments.forEach(function (s, i) {
        var btn = el('button', {
          class: 'line', attrs: { type: 'button', title: 'Play from ' + TD.clock(s.start) },
          dataset: { index: i },
          on: { click: function () { seek(s.start); } }
        }, el('span', { class: 'ts', text: TD.clock(s.start) }), el('span', { class: 'tx', text: s.text }));
        ui.lines.appendChild(el('li', {}, btn));
      });
    } else if (d.text) {
      ui.text.textContent = d.text;
      ui.text.hidden = false;
    }
    ui.vHint.hidden = !(segments.length && !ui.audio.hidden);
  }

  function seek(start) {
    if (ui.audio.hidden || !ui.audio.src) return;
    ui.audio.currentTime = Math.max(0, Number(start) || 0);
    var p = ui.audio.play();
    if (p && p.catch) p.catch(function () { /* autoplay blocked: the user can press play */ });
  }

  ui.audio.addEventListener('timeupdate', function () {
    var segs = (state.detail && state.detail.segments) || [];
    var t = ui.audio.currentTime, idx = -1;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].start <= t + 0.05) idx = i; else break;
    }
    if (idx !== -1 && t > segs[idx].end + 1.5) idx = -1; // in a silence after the line
    if (idx === state.activeLine) return;
    var old = ui.lines.querySelector('.line.active');
    if (old) old.classList.remove('active');
    state.activeLine = idx;
    var btn = idx >= 0 ? ui.lines.querySelector('.line[data-index="' + idx + '"]') : null;
    if (btn) {
      btn.classList.add('active');
      var box = ui.lines, top = btn.offsetTop - box.offsetTop;
      if (top < box.scrollTop || top + btn.offsetHeight > box.scrollTop + box.clientHeight) {
        box.scrollTop = top - box.clientHeight / 3;
      }
    }
  });
  ui.audio.addEventListener('error', function () {
    if (ui.audio.getAttribute('src')) { ui.audio.hidden = true; ui.vHint.hidden = true; }
  });

  // ----- actions ---------------------------------------------------------------------------
  function flash(text, isError) {
    ui.vMsg.textContent = text;
    ui.vMsg.className = 'msg' + (isError ? ' error' : ' ok');
  }

  ui.copy.addEventListener('click', function () {
    var text = (state.detail && state.detail.text) || '';
    if (!text) return;
    var fallback = function () {
      var ta = el('textarea', { attrs: { readonly: 'readonly' } });
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      flash(ok ? 'Text copied.' : 'Copy failed. Select the text and press Ctrl+C.', !ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash('Text copied.', false); }, fallback);
    } else {
      fallback();
    }
  });

  ui.srt.addEventListener('click', function () {
    var d = state.detail;
    if (!d) return;
    ui.srt.disabled = true;
    fetch('/app-api/transcriptions/' + d.id + '/srt', { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var data = null;
          try { data = JSON.parse(t); } catch (e) { data = null; }
          throw new Error(TD.errorMessage(res.status, data));
        });
      }
      return res.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = el('a', { attrs: { href: url, download: d.filename.replace(/\.[^.]+$/, '') + '.srt' } });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        flash('SRT downloaded.', false);
      });
    }).catch(function (err) {
      flash('Download failed: ' + err.message, true);
    }).then(function () { ui.srt.disabled = !(state.detail && state.detail.status === 'completed'); });
  });

  ui.del.addEventListener('click', function () {
    var d = state.detail;
    if (!d) return;
    if (!window.confirm('Delete "' + d.filename + '"?\nIt is also deleted on the Transcribe API.')) return;
    ui.del.disabled = true;
    TD.api('DELETE', '/app-api/transcriptions/' + d.id).then(function () {
      if (state.objectUrls[d.id]) { URL.revokeObjectURL(state.objectUrls[d.id]); delete state.objectUrls[d.id]; }
      state.items = state.items.filter(function (i) { return i.id !== d.id; });
      state.selectedId = null;
      state.detail = null;
      state.linesKey = '';
      ui.audio.pause();
      ui.audio.removeAttribute('src');
      ui.audio.dataset.forId = '';
      ui.vBody.hidden = true;
      ui.vEmpty.hidden = false;
      renderList();
      schedulePoll();
    }).catch(function (err) {
      flash('Delete failed: ' + err.message, true);
    }).then(function () { ui.del.disabled = false; });
  });

  loadList();
})();
