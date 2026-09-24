// Browser host for db-inspector.html: plays the role the Android activity / iOS view
// controller play in the plugin. It implements the same bridge (invoke + __dbiResolve),
// runs SQLite in a Web Worker, and adds the web-only bits: opening local files (picker or
// drag & drop), downloads, localStorage, and the landing screen.
//
// Nothing here talks to a server: files are read in place by the worker, and the site's
// Content-Security-Policy only allows fetching its own static assets (connect-src 'self').
(function () {
  'use strict';

  var PREFIX = 'hfps_db_inspector.';
  var REPO_URL = 'https://github.com/henriquefps/cordova-plugin-db-inspector';

  var worker = null;
  var workerCalls = {};   // workerCallId -> page callId
  var workerSeq = 0;
  var files = [];         // { id, name, file, wal }
  var fileSeq = 0;

  function deliver(callId, envelope) {
    // __dbiResolve is defined by the page script, which runs right after this one.
    window.__dbiResolve(callId, JSON.stringify(envelope));
  }
  function ok(callId, data) { deliver(callId, { ok: true, data: data === undefined ? null : data }); }
  function fail(callId, message) { deliver(callId, { ok: false, error: message }); }

  // ---- worker lifecycle ------------------------------------------------------------------

  function startWorker() {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'booted') return;
      var target = workerCalls[m.callId];
      delete workerCalls[m.callId];
      if (target) target(m.envelope);
    };
    worker.onerror = function (e) {
      console.error('DB Inspector worker error', e);
    };
    files.forEach(function (f) { postRegister(f); });
  }

  function toWorker(message) {
    return new Promise(function (resolve) {
      var id = ++workerSeq;
      workerCalls[id] = resolve;
      message.callId = id;
      worker.postMessage(message);
    });
  }

  function postRegister(f) {
    return toWorker({ type: 'register', id: f.id, name: f.name, file: f.file, wal: f.wal || null });
  }

  /**
   * A running SQLite statement can't be interrupted from outside the worker, so cancelling
   * means replacing the worker. Re-opening is instant: the VFS reads files lazily.
   */
  function restartWorker() {
    worker.terminate();
    var pending = workerCalls;
    workerCalls = {};
    Object.keys(pending).forEach(function (k) { pending[k]({ ok: false, error: 'Query cancelled.' }); });
    startWorker();
  }

  // ---- files -------------------------------------------------------------------------------

  var SIDE = /-(wal|shm|journal)$/i;

  /** Adds File objects; pairs "x.db" with "x.db-wal" (in the same batch or already open). */
  function addFileList(list) {
    var incoming = Array.prototype.slice.call(list || []);
    var mains = incoming.filter(function (f) { return !SIDE.test(f.name); });
    var wals = incoming.filter(function (f) { return /-wal$/i.test(f.name); });
    var added = [];
    var jobs = [];
    mains.forEach(function (file) {
      var wal = wals.filter(function (w) { return w.name.replace(/-wal$/i, '') === file.name; })[0] || null;
      var entry = { id: 'local/' + (++fileSeq) + '/' + file.name, name: file.name, file: file, wal: wal };
      files.push(entry);
      added.push(entry.id);
      jobs.push(postRegister(entry));
    });
    // A -wal dropped on its own attaches to an already-open database with the same name.
    wals.forEach(function (w) {
      var base = w.name.replace(/-wal$/i, '');
      if (mains.some(function (m) { return m.name === base; })) return;
      var existing = files.filter(function (f) { return f.name === base; }).pop();
      if (existing) {
        existing.wal = w;
        added.push(existing.id);
        jobs.push(postRegister(existing));
      }
    });
    return Promise.all(jobs).then(function () {
      if (added.length) hideLanding();
      return added;
    });
  }

  function pickFiles(accept, multiple) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = !!multiple;
      input.style.display = 'none';
      var done = false;
      input.addEventListener('change', function () { done = true; resolve(input.files); input.remove(); });
      input.addEventListener('cancel', function () { if (!done) resolve(null); input.remove(); });
      document.body.appendChild(input);
      input.click();
    });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function loadDemo() {
    return fetch('demo.db').then(function (r) {
      if (!r.ok) throw new Error('Demo database not available');
      return r.blob();
    }).then(function (blob) {
      return addFileList([new File([blob], 'demo-outsystems.db', { type: 'application/vnd.sqlite3', lastModified: Date.now() })]);
    });
  }

  // ---- bridge ------------------------------------------------------------------------------

  var local = {
    context: function () {
      return {
        platform: 'web', osVersion: browserName(), device: 'Browser', appId: location.host || 'local',
        appVersion: '', options: { title: 'DB Inspector' }, canAddFiles: true, canClose: false
      };
    },
    storageGet: function (a) {
      try { return localStorage.getItem(PREFIX + a.key); } catch (e) { return null; }
    },
    storageSet: function (a) {
      try {
        if (a.value == null) localStorage.removeItem(PREFIX + a.key);
        else localStorage.setItem(PREFIX + a.key, a.value);
      } catch (e) { /* private mode / quota: keep working without persistence */ }
      return true;
    },
    saveFile: function (a) {
      var body = a.base64 ? base64ToBytes(a.content || '') : (a.content || '');
      download(new Blob([body], { type: a.mime || 'application/octet-stream' }), a.name || 'export.txt');
      return { saved: true };
    },
    pickFile: function () {
      return pickFiles('.json,application/json,text/plain', false).then(function (list) {
        if (!list || !list.length) return { cancelled: true };
        var f = list[0];
        if (f.size > 10 * 1024 * 1024) throw new Error('File is larger than 10 MB');
        return f.text().then(function (text) { return { name: f.name, text: text }; });
      });
    },
    addFiles: function () {
      return pickFiles('', true).then(function (list) { return list ? addFileList(list) : []; });
    },
    exportDatabase: function (a) {
      return toWorker({ type: 'call', action: 'exportDatabase', args: a }).then(function (env) {
        if (!env.ok) throw new Error(env.error);
        download(env.data.blob, env.data.name);
        return { saved: true };
      });
    },
    setTheme: function (a) {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', a.color || (a.dark ? '#151b24' : '#ffffff'));
      document.documentElement.classList.toggle('dbi-dark', !!a.dark);
      return true;
    },
    close: function () { return true; },
    interrupt: function () { restartWorker(); return true; }
  };

  window.DbInspectorHost = {
    invoke: function (callId, action, argsJson) {
      var args = {};
      try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { /* keep {} */ }
      if (local[action]) {
        Promise.resolve().then(function () { return local[action](args); })
          .then(function (data) { ok(callId, data); }, function (e) { fail(callId, e && e.message ? e.message : String(e)); });
        return;
      }
      toWorker({ type: 'call', action: action, args: args }).then(function (env) { deliver(callId, env); });
    }
  };

  function browserName() {
    var ua = navigator.userAgent;
    var m = /(Edg|Chrome|Firefox|Version)\/([\d.]+)/.exec(ua);
    var name = m ? (m[1] === 'Version' ? 'Safari' : m[1] === 'Edg' ? 'Edge' : m[1]) + ' ' + m[2].split('.')[0] : 'Browser';
    return name;
  }

  // ---- landing & drag and drop --------------------------------------------------------------

  var landing = null;

  function hideLanding() {
    if (landing) { landing.classList.add('dbi-hide'); setTimeout(function () { if (landing) landing.remove(); landing = null; }, 250); }
  }

  function showLanding() {
    landing = document.createElement('div');
    landing.className = 'dbi-landing';
    landing.innerHTML =
      '<div class="dbi-card">' +
      '<div class="dbi-brand"><span class="dbi-logo"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg></span>DB Inspector</div>' +
      '<h1>Inspect a SQLite database<br>right in your browser</h1>' +
      '<p class="dbi-lead">Browse tables and data, read the structure, build queries visually and save presets. Made for Cordova, Capacitor and OutSystems mobile databases, and it works with any SQLite file.</p>' +
      '<label class="dbi-drop" id="dbiDrop"><input type="file" id="dbiInput" multiple hidden>' +
      '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>' +
      '<b>Drop your .db file here</b><span>or click to choose. Add its <code>-wal</code> file too, to include changes that haven’t been checkpointed yet.</span></label>' +
      '<div class="dbi-actions"><button class="dbi-btn" id="dbiDemo">Try the demo database</button></div>' +
      '<ul class="dbi-points">' +
      '<li><b>Your file never leaves this device.</b> SQLite runs locally in WebAssembly. Nothing is uploaded, and the page’s security policy blocks connections to any other site.</li>' +
      '<li><b>Read-only.</b> Databases are opened read-only; your file is never modified.</li>' +
      '<li><b>Large files welcome.</b> Pages are read on demand, so a 500 MB database opens in a moment.</li>' +
      '</ul>' +
      '<p class="dbi-foot">The same inspector ships inside apps as <a href="' + REPO_URL + '" target="_blank" rel="noopener">cordova-plugin-db-inspector</a>, an open-source Cordova/Capacitor plugin (Apache 2.0). ' +
      'Tip: in the app, <em>Info → Export database file</em> produces a single consistent file you can open here.</p>' +
      '</div>';
    document.body.appendChild(landing);
    var input = landing.querySelector('#dbiInput');
    input.addEventListener('change', function () { openFromUser(input.files); });
    landing.querySelector('#dbiDemo').addEventListener('click', function (e) {
      e.target.disabled = true;
      e.target.textContent = 'Loading demo…';
      loadDemo().then(announce, function (err) { e.target.disabled = false; e.target.textContent = 'Try the demo database'; alert(err.message); });
    });
  }

  function announce(ids) {
    if (ids && ids.length && window.__dbiDatabasesChanged) window.__dbiDatabasesChanged(ids[0]);
  }

  function openFromUser(list) {
    addFileList(list).then(announce);
  }

  function installDragAndDrop() {
    var depth = 0;
    var hint = document.createElement('div');
    hint.className = 'dbi-dragging';
    hint.innerHTML = '<div>Drop to open — the file stays on this device</div>';
    document.body.appendChild(hint);
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      e.preventDefault();
      if (depth++ === 0) hint.classList.add('on');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; hint.classList.remove('on'); } });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      hint.classList.remove('on');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) openFromUser(e.dataTransfer.files);
    });
  }

  startWorker();
  document.addEventListener('DOMContentLoaded', function () {
    showLanding();
    installDragAndDrop();
    if (/[?&]demo\b/.test(location.search)) loadDemo().then(announce);
  });
})();
