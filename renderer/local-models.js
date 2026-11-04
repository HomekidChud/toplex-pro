/* Toplix Pro — local models on this phone.
 * Android only. Models are downloaded once (from huggingface.co), stored in the app's private
 * storage and run by Google's MediaPipe LLM engine, on the phone's GPU when the user allows it.
 * Chats never leave the device while a local model is used.
 */
(function () {
  'use strict';
  var CONSENT_KEY = 'toplex.local.consent';
  var CONSENT_VERSION = 1;
  var HF = 'https://huggingface.co/litert-community/';

  var CATALOG = [
    {
      id: 'qwen2.5-0.5b-instruct', name: 'Qwen2.5 0.5B Instruct', size: '547 MB', minRamGb: 3,
      note: 'Small and fast. Good for quick questions and short code.',
      url: HF + 'Qwen2.5-0.5B-Instruct/resolve/main/Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task',
      template: 'chatml', maxTokens: 1280
    },
    {
      id: 'qwen2.5-1.5b-instruct', name: 'Qwen2.5 1.5B Instruct', size: '1.6 GB', minRamGb: 6,
      note: 'Noticeably smarter, needs a recent phone with 6 GB of RAM or more.',
      url: HF + 'Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.task',
      template: 'chatml', maxTokens: 4096
    },
    {
      id: 'gemma3-1b-it', name: 'Gemma 3 1B', size: '555 MB', minRamGb: 4, gated: true,
      note: 'Google\u2019s small model. Needs a free Hugging Face account and token (license acceptance).',
      page: 'https://huggingface.co/litert-community/Gemma3-1B-IT',
      url: HF + 'Gemma3-1B-IT/resolve/main/Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task',
      template: 'gemma', maxTokens: 2048
    },
    {
      id: 'smollm-135m-instruct', name: 'SmolLM 135M (tiny test model)', size: '167 MB', minRamGb: 2,
      note: 'Very small. Use it to check that your phone and GPU work before downloading a bigger model.',
      url: HF + 'SmolLM-135M-Instruct/resolve/main/SmolLM-135M-Instruct_multi-prefill-seq_q8_ekv1280.task',
      template: 'chatml', maxTokens: 1280
    }
  ];

  var cap = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
    ? (window.Capacitor.Plugins || {}).ToplixLocalLLM : null;

  var installed = [];
  var dl = {};                 // id -> { received, total, error }
  var status = null;           // device info from the native side
  var loaded = { id: null, backend: null };
  var tokenHandlers = {};
  var changeFns = [];
  var mounts = [];

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function A() { return window.ToplixApp; }
  function fmtBytes(b) {
    if (!b) return '0 MB';
    return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';
  }

  /* ---------- consent ---------- */
  function readConsent() { try { return JSON.parse(window.ToplixStore.get(CONSENT_KEY) || 'null'); } catch (e) { return null; } }
  function writeConsent(c) {
    window.ToplixStore.set(CONSENT_KEY, JSON.stringify(Object.assign({ v: CONSENT_VERSION, at: new Date().toISOString() }, c)));
  }
  function hasConsent() { var c = readConsent(); return !!(c && c.v === CONSENT_VERSION); }
  function gpuEnabled() { var c = readConsent(); return !!(c && c.gpu); }

  function askConsent() {
    return new Promise(function (resolve, reject) {
      var overlay = el('div', 'lm-overlay');
      var dlg = el('div', 'lm-dialog');
      dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'lm-consent-title');
      var t = el('h2', 'lm-dialog-title', 'Run AI models on this phone?'); t.id = 'lm-consent-title';
      dlg.appendChild(t);
      dlg.appendChild(el('p', 'lm-dialog-sub', 'Toplix Pro would like your permission to do the following.'));
      [
        ['Use this phone\u2019s GPU', 'Android has no separate GPU permission, so we ask first. Using the GPU makes answers much faster but warms the phone and uses more battery while a model is answering.'],
        ['Store model files on this phone', 'Models are 0.2 to 2 GB each and kept in Toplix Pro\u2019s private storage. You can remove them any time.'],
        ['Download models from huggingface.co', 'This is the only network use. Once a model is downloaded, chats with it stay on the phone and work offline.']
      ].forEach(function (r) {
        var row = el('div', 'lm-dialog-row');
        row.appendChild(el('div', 'lm-dialog-row-title', r[0]));
        row.appendChild(el('div', 'lm-dialog-row-sub', r[1]));
        dlg.appendChild(row);
      });
      var actions = el('div', 'lm-dialog-actions');
      var gpu = el('button', 'btn primary gate-btn', 'Allow GPU and continue');
      var cpu = el('button', 'btn ghost gate-btn', 'Use CPU only (slower)');
      var no = el('button', 'btn ghost gate-btn', 'Not now');
      [gpu, cpu, no].forEach(function (b) { b.type = 'button'; actions.appendChild(b); });
      dlg.appendChild(actions);
      overlay.appendChild(dlg);
      document.body.appendChild(overlay);
      gpu.focus();
      function close() { overlay.remove(); }
      gpu.addEventListener('click', function () { writeConsent({ gpu: true, storage: true }); close(); changed(); resolve({ gpu: true }); });
      cpu.addEventListener('click', function () { writeConsent({ gpu: false, storage: true }); close(); changed(); resolve({ gpu: false }); });
      no.addEventListener('click', function () { close(); var e = new Error('Permission not granted'); e.name = 'ConsentDeclined'; reject(e); });
    });
  }

  function ensureConsent() { return hasConsent() ? Promise.resolve({ gpu: gpuEnabled() }) : askConsent(); }

  /* ---------- state ---------- */
  function available() { return !!cap; }
  function installedList() { return installed.slice(); }
  function isInstalled(id) { return installed.some(function (m) { return m.id === id; }); }
  function hasModel() { return installed.length > 0 && hasConsent(); }
  function label(id) {
    var m = installed.filter(function (x) { return x.id === id; })[0];
    if (m && m.name) return m.name;
    var c = CATALOG.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : id;
  }

  function onChange(fn) { changeFns.push(fn); }
  function changed() {
    changeFns.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    renderMounts();
  }

  function refresh() {
    if (!cap) return Promise.resolve();
    return Promise.all([
      cap.models().then(function (r) { installed = (r.models || []); }).catch(function () {}),
      cap.status().then(function (r) { status = r; }).catch(function () {})
    ]).then(changed);
  }

  /* ---------- native events ---------- */
  function onEvent(e) {
    if (!e) return;
    if (e.type === 'token') {
      var h = tokenHandlers[e.rid];
      if (h) h(e);
    } else if (e.type === 'download-progress') {
      dl[e.id] = Object.assign(dl[e.id] || {}, { received: e.received, total: e.total, error: '' });
      updateBars(e.id);
    } else if (e.type === 'download-done') {
      delete dl[e.id];
      refresh();
    } else if (e.type === 'download-error') {
      dl[e.id] = { error: e.message || 'Download failed' };
      renderMounts();
    } else if (e.type === 'download-cancelled') {
      delete dl[e.id];
      renderMounts();
    }
  }

  function init() {
    if (!cap) return;
    cap.addListener('llm', onEvent);
    refresh();
  }

  /* ---------- actions ---------- */
  function getToken() {
    var N = window.ToplixNative;
    return N && N.secureGet ? N.secureGet('hf.token').then(function (t) { return t || ''; }).catch(function () { return ''; }) : Promise.resolve('');
  }
  function setToken(t) {
    var N = window.ToplixNative;
    if (!N || !N.secureSet) return Promise.resolve();
    return t ? N.secureSet('hf.token', t) : N.secureRemove('hf.token');
  }

  function startDownload(item, token) {
    return ensureConsent().then(function () {
      dl[item.id] = { received: 0, total: 0, error: '' };
      renderMounts();
      return cap.download({ id: item.id, url: item.url, name: item.name, template: item.template, maxTokens: item.maxTokens, token: item.gated ? token : '' });
    }).catch(function (e) {
      if (e && e.name === 'ConsentDeclined') return;
      dl[item.id] = { error: (e && e.message) || 'Download failed' };
      renderMounts();
    });
  }

  function remove(id) {
    if (loaded.id === id) loaded = { id: null, backend: null };
    return cap.remove({ id: id }).then(refresh);
  }

  function ensureLoaded(id, onStatus) {
    var wantGpu = gpuEnabled();
    if (loaded.id === id && (loaded.backend === 'gpu') === wantGpu) return Promise.resolve();
    if (onStatus) onStatus('Loading ' + label(id) + (wantGpu ? ' on the GPU' : '') + '\u2026 the first time can take up to a minute.');
    return cap.load({ id: id, backend: wantGpu ? 'gpu' : 'cpu' }).then(function (r) {
      loaded = { id: id, backend: r.backend };
      if (wantGpu && r.backend !== 'gpu' && A()) A().toast('The GPU could not be used on this phone, so the CPU is being used instead.');
      changed();
    });
  }

  function generate(o) {
    return ensureConsent().then(function () { return ensureLoaded(o.id, o.onStatus); }).then(function () {
      var rid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      tokenHandlers[rid] = function (e) { if (e.text) o.onToken(e.text); };
      var onAbort = function () { cap.stop(); };
      if (o.signal) o.signal.addEventListener('abort', onAbort);
      function cleanup() {
        if (o.signal) o.signal.removeEventListener('abort', onAbort);
        setTimeout(function () { delete tokenHandlers[rid]; }, 400);
      }
      return cap.generate({ rid: rid, messages: o.messages, system: o.system || '', temperature: o.temperature })
        .then(function (r) {
          cleanup();
          if ((r && r.stopped) || (o.signal && o.signal.aborted)) { var e = new Error('stopped'); e.name = 'AbortError'; throw e; }
        }, function (err) { cleanup(); throw err; });
    });
  }

  /* ---------- manager UI ---------- */
  function updateBars(id) {
    var s = dl[id];
    mounts.forEach(function (m) {
      var bar = m.root.querySelector('[data-bar="' + id + '"]');
      var txt = m.root.querySelector('[data-bar-text="' + id + '"]');
      if (!bar || !s) return;
      var pct = s.total ? Math.min(100, Math.round(s.received / s.total * 100)) : 0;
      bar.style.width = (s.total ? pct : 100) + '%';
      bar.classList.toggle('indeterminate', !s.total);
      if (txt) txt.textContent = s.total ? fmtBytes(s.received) + ' of ' + fmtBytes(s.total) + ' (' + pct + '%)' : fmtBytes(s.received);
    });
  }

  function renderMounts() {
    mounts = mounts.filter(function (m) { return document.body.contains(m.root); });
    mounts.forEach(function (m) { draw(m); });
  }

  function mount(root, opts) {
    var m = { root: root, opts: opts || {}, token: '', importTemplate: 'gemma' };
    mounts = mounts.filter(function (x) { return x.root !== root; });
    mounts.push(m);
    getToken().then(function (t) { m.token = t; draw(m); });
    refresh().then(function () { draw(m); });
    draw(m);
  }

  function useModel(id, m) {
    var a = A();
    a.state.settings.activeProvider = 'device';
    a.state.settings.providers.device.model = id;
    a.persist();
    a.renderModelMenu();
    a.updateModelUI();
    a.toast('Using ' + label(id));
    if (m.opts.onUse) m.opts.onUse(id);
    renderMounts();
  }

  function draw(m) {
    var root = m.root;
    // keep what the user is typing when we redraw on progress or state changes
    var typed = root.querySelector('.lm-token');
    if (typed) m.token = typed.value;
    root.innerHTML = '';
    root.classList.add('lm');

    if (!cap) { root.appendChild(el('p', 'lm-note', 'Local models run in the Android app. On desktop, use the Custom provider with Ollama or LM Studio.')); return; }
    if (status && !status.supported) {
      root.appendChild(el('p', 'lm-note', 'This phone can\u2019t run on-device models. A 64-bit ARM phone running Android 7 or newer is required.'));
      return;
    }

    // device + GPU
    var dev = el('div', 'lm-block');
    var ram = status ? (status.ramMb / 1024).toFixed(1) + ' GB memory' : '';
    var free = status ? ' \u00b7 ' + (status.freeStorageMb / 1024).toFixed(1) + ' GB free' : '';
    dev.appendChild(el('div', 'lm-block-title', status ? status.device : 'This phone'));
    dev.appendChild(el('div', 'lm-meta', ram + free));
    var gpuRow = el('label', 'lm-gpu-row');
    var tx = el('span', 'lm-gpu-text');
    tx.appendChild(el('span', 'lm-name', 'Use the phone\u2019s GPU'));
    tx.appendChild(el('span', 'lm-meta', hasConsent()
      ? (gpuEnabled() ? 'Allowed. Answers are much faster and use more battery.' : 'Off. The CPU is used, which is slower.')
      : 'Not allowed yet. You\u2019ll be asked before the first download.'));
    var sw = el('span', 'gate-switch');
    var cb = el('input'); cb.type = 'checkbox'; cb.checked = gpuEnabled();
    sw.appendChild(cb); sw.appendChild(el('span', 'gate-switch-track'));
    gpuRow.appendChild(tx); gpuRow.appendChild(sw);
    cb.addEventListener('change', function () {
      if (cb.checked) { cb.checked = false; askConsent().catch(function () {}); }
      else { writeConsent({ gpu: false, storage: true }); loaded = { id: null, backend: null }; changed(); }
    });
    dev.appendChild(gpuRow);
    if (status && !status.gpuLikely) dev.appendChild(el('div', 'lm-meta', 'No GPU compute driver was found, so models may fall back to the CPU automatically.'));
    root.appendChild(dev);

    // installed models
    var active = A() ? A().state.settings : null;
    if (installed.length) {
      root.appendChild(el('div', 'lm-section', 'On this phone'));
      installed.forEach(function (mod) {
        var item = el('div', 'lm-item');
        var top = el('div', 'lm-item-top');
        var txt = el('div', 'lm-item-text');
        txt.appendChild(el('div', 'lm-name', mod.name || mod.id));
        var isActive = active && active.activeProvider === 'device' && active.providers.device.model === mod.id;
        txt.appendChild(el('div', 'lm-meta', fmtBytes(mod.size) + (isActive ? ' \u00b7 in use' : '')));
        top.appendChild(txt);
        var acts = el('div', 'lm-actions');
        var use = el('button', 'btn primary', isActive ? 'In use' : 'Use'); use.type = 'button'; use.disabled = !!isActive;
        use.addEventListener('click', function () { ensureConsent().then(function () { useModel(mod.id, m); }).catch(function () {}); });
        var del = el('button', 'btn ghost', 'Remove'); del.type = 'button';
        del.addEventListener('click', function () {
          if (window.confirm('Remove ' + (mod.name || mod.id) + ' from this phone?')) remove(mod.id);
        });
        acts.appendChild(use); acts.appendChild(del);
        top.appendChild(acts);
        item.appendChild(top);
        root.appendChild(item);
      });
    }

    // catalog
    root.appendChild(el('div', 'lm-section', 'Download a model'));
    CATALOG.forEach(function (c) {
      if (isInstalled(c.id)) return;
      var s = dl[c.id];
      var item = el('div', 'lm-item');
      var top = el('div', 'lm-item-top');
      var txt = el('div', 'lm-item-text');
      txt.appendChild(el('div', 'lm-name', c.name));
      txt.appendChild(el('div', 'lm-meta', c.size + ' \u00b7 ' + c.note));
      if (status && status.ramMb / 1024 < c.minRamGb) txt.appendChild(el('div', 'lm-warn', 'Needs about ' + c.minRamGb + ' GB of memory. It may not load on this phone.'));
      top.appendChild(txt);
      var acts = el('div', 'lm-actions');
      if (s && !s.error && (s.received !== undefined)) {
        var cancel = el('button', 'btn ghost', 'Cancel'); cancel.type = 'button';
        cancel.addEventListener('click', function () { cap.cancelDownload({ id: c.id, discard: false }); delete dl[c.id]; renderMounts(); });
        acts.appendChild(cancel);
      } else {
        var get = el('button', 'btn primary', s && s.error ? 'Retry' : 'Download'); get.type = 'button';
        get.addEventListener('click', function () {
          if (c.gated && !m.token) {
            dl[c.id] = { error: 'Paste your Hugging Face access token below first.' };
            renderMounts();
            return;
          }
          startDownload(c, m.token);
        });
        acts.appendChild(get);
      }
      top.appendChild(acts);
      item.appendChild(top);

      if (s && !s.error && s.received !== undefined) {
        var track = el('div', 'lm-bar');
        var fill = el('div', 'lm-bar-fill'); fill.setAttribute('data-bar', c.id);
        track.appendChild(fill);
        item.appendChild(track);
        var bt = el('div', 'lm-meta'); bt.setAttribute('data-bar-text', c.id);
        item.appendChild(bt);
      }
      if (s && s.error) item.appendChild(el('div', 'lm-error', s.error));

      if (c.gated) {
        var tokRow = el('div', 'lm-token-row');
        var tok = el('input', 'lm-token'); tok.type = 'password'; tok.placeholder = 'Hugging Face token (hf_\u2026)'; tok.autocomplete = 'off';
        tok.value = m.token || '';
        tok.addEventListener('change', function () { m.token = tok.value.trim(); setToken(m.token); });
        var help = el('button', 'btn ghost', 'Accept license'); help.type = 'button';
        help.addEventListener('click', function () {
          var N = window.ToplixNative;
          if (N && N.openExternal) N.openExternal(c.page).catch(function () {}); else window.open(c.page, '_blank', 'noopener');
        });
        tokRow.appendChild(tok); tokRow.appendChild(help);
        item.appendChild(tokRow);
      }
      root.appendChild(item);
    });

    // import
    var imp = el('div', 'lm-item');
    var itop = el('div', 'lm-item-top');
    var itx = el('div', 'lm-item-text');
    itx.appendChild(el('div', 'lm-name', 'Use a model file you already have'));
    itx.appendChild(el('div', 'lm-meta', 'A .task or .litertlm file from the LiteRT Community on Hugging Face.'));
    itop.appendChild(itx);
    imp.appendChild(itop);
    var irow = el('div', 'lm-token-row');
    var sel = el('select', 'lm-select');
    [['gemma', 'Gemma style'], ['chatml', 'Qwen / ChatML style'], ['plain', 'Plain text']].forEach(function (o) {
      var op = el('option', '', o[1]); op.value = o[0]; sel.appendChild(op);
    });
    sel.value = m.importTemplate;
    sel.addEventListener('change', function () { m.importTemplate = sel.value; });
    var pick = el('button', 'btn ghost', 'Choose file'); pick.type = 'button';
    pick.addEventListener('click', function () {
      ensureConsent().then(function () {
        return cap.importModel({ template: m.importTemplate, maxTokens: 1024 });
      }).then(function () { A().toast('Model imported'); return refresh(); })
        .catch(function (e) { if (e && e.name !== 'ConsentDeclined' && A()) A().toast((e && e.message) || 'Import failed'); });
    });
    irow.appendChild(sel); irow.appendChild(pick);
    imp.appendChild(irow);
    root.appendChild(imp);

    Object.keys(dl).forEach(updateBars);
  }

  window.ToplixLocal = {
    available: available, init: init, refresh: refresh, mount: mount,
    installed: installedList, isInstalled: isInstalled, hasModel: hasModel, label: label,
    hasConsent: hasConsent, gpuEnabled: gpuEnabled, ensureConsent: ensureConsent,
    generate: generate, onChange: onChange
  };
})();
