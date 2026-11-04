/* Toplix Pro — Local models hub.
 * A dedicated screen (different from the normal settings UI) for running AI models
 * on the user's own machine: Ollama, LM Studio, Jan or any OpenAI-compatible
 * server. It scans the usual local ports, lists what it finds and connects a
 * model with one click. Works on desktop (localhost) and on phones (use the
 * computer's Wi-Fi address).
 */
(function () {
  'use strict';

  var SERVERS = [
    { name: 'Ollama', url: 'http://localhost:11434/v1' },
    { name: 'LM Studio', url: 'http://localhost:1234/v1' },
    { name: 'Jan', url: 'http://localhost:1337/v1' }
  ];

  function A() { return window.ToplixApp; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  /* ---------- server probing ---------- */
  function probe(server) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 4000);
    return fetch(server.url.replace(/\/+$/, '') + '/models', { signal: ctl.signal })
      .then(function (r) { clearTimeout(t); return r.ok ? r.json() : null; })
      .then(function (d) {
        var list = d && d.data ? d.data : [];
        return {
          ok: true,
          models: list.map(function (m) {
            return { id: m.id, size: m.size || null };
          })
        };
      })
      .catch(function () { clearTimeout(t); return { ok: false, models: [] }; });
  }

  function scan(servers) {
    return Promise.all(servers.map(function (s) { return probe(s).then(function (r) { return { server: s, result: r }; }); }));
  }

  /* ---------- the hub UI ---------- */
  var overlay = null;

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function useModel(server, modelId) {
    var app = A();
    if (!app) return;
    var cfg = app.state.settings.providers.custom;
    cfg.baseUrl = server.url;
    cfg.model = modelId;
    if (app.PROVIDERS.custom.models.indexOf(modelId) < 0) app.PROVIDERS.custom.models.unshift(modelId);
    app.state.settings.activeProvider = 'custom';
    app.persist();
    app.renderModelMenu();
    app.updateModelUI();
    close();
    app.toast('Using ' + modelId + ' via ' + server.name + ' on this machine');
  }

  function renderResults(host, servers) {
    host.innerHTML = '';
    scan(servers).then(function (rows) {
      var found = 0;
      rows.forEach(function (row) {
        var card = el('div', 'lh-server' + (row.result.ok ? ' on' : ''));
        var head = el('div', 'lh-server-head');
        var dot = el('span', 'lh-dot');
        var meta = el('div', 'lh-server-meta');
        meta.appendChild(el('div', 'lh-server-name', row.server.name));
        meta.appendChild(el('div', 'lh-server-url', row.server.url));
        head.appendChild(dot); head.appendChild(meta);
        head.appendChild(el('span', 'lh-server-state', row.result.ok ? 'Running' : 'Not detected'));
        card.appendChild(head);

        if (row.result.ok && row.result.models.length) {
          found++;
          var list = el('div', 'lh-models');
          row.result.models.forEach(function (m) {
            var item = el('div', 'lh-model');
            var info = el('div', 'lh-model-info');
            info.appendChild(el('div', 'lh-model-name', m.id));
            info.appendChild(el('div', 'lh-model-size', m.size ? fmt(m.size) : 'local'));
            var btn = el('button', 'btn primary', 'Use');
            btn.type = 'button';
            btn.addEventListener('click', function () { useModel(row.server, m.id); });
            item.appendChild(info); item.appendChild(btn);
            list.appendChild(item);
          });
          card.appendChild(list);
        } else if (row.result.ok) {
          card.appendChild(el('div', 'lh-empty', 'The server is running but lists no models yet. Pull or load one first (e.g. "ollama pull llama3.3").'));
        }
        host.appendChild(card);
      });

      if (!found) {
        var none = el('div', 'lh-none');
        none.appendChild(el('div', 'lh-none-title', 'No local models found'));
        none.appendChild(el('p', '', 'Toplix Pro looked for Ollama, LM Studio and Jan on this machine. To run models locally:'));
        var steps = el('ol', 'lh-none-steps');
        steps.appendChild(el('li', '', 'Install Ollama from ollama.com (or LM Studio from lmstudio.ai)'));
        steps.appendChild(el('li', '', 'Download a model, e.g. run "ollama pull llama3.3"'));
        steps.appendChild(el('li', '', 'Come back here and scan again'));
        none.appendChild(steps);
        var hint = el('p', 'lh-none-hint', 'On a phone, use your computer\u2019s Wi-Fi address instead of localhost (like http://192.168.1.20:11434/v1) and make sure the server accepts connections from other devices.');
        none.appendChild(hint);
        var link = el('a', 'lh-none-link', 'Open ollama.com');
        link.href = 'https://ollama.com';
        link.target = '_blank';
        link.rel = 'noopener';
        none.appendChild(link);
        host.appendChild(none);
      }
    });
  }

  function fmt(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB'; }

  function open() {
    if (overlay) return;
    overlay = el('div', 'lh-overlay');
    overlay.id = 'lh-overlay';
    var panel = el('div', 'lh-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'lh-title');

    var head = el('div', 'lh-head');
    var titles = el('div');
    titles.appendChild(el('h2', 'lh-title', 'Run local models'));
    titles.appendChild(el('p', 'lh-sub', 'AI running on your own machine — private, offline and free. Toplix Pro scans for local servers and connects them in one click.'));
    head.appendChild(titles);
    var closeBtn = el('button', 'lh-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var actions = el('div', 'lh-actions');
    var rescan = el('button', 'btn ghost', 'Scan again');
    rescan.type = 'button';
    rescan.id = 'lh-rescan';
    actions.appendChild(rescan);

    var addWrap = el('div', 'lh-add');
    var addInput = el('input');
    addInput.type = 'text';
    addInput.placeholder = 'Add a server — http://192.168.1.20:11434/v1';
    addInput.id = 'lh-add-url';
    var addBtn = el('button', 'btn primary', 'Add');
    addBtn.type = 'button';
    addWrap.appendChild(addInput); addWrap.appendChild(addBtn);
    actions.appendChild(addWrap);
    panel.appendChild(actions);

    var results = el('div', 'lh-results');
    results.id = 'lh-results';
    panel.appendChild(results);

    var foot = el('p', 'lh-foot', 'Any OpenAI-compatible server works. Chats with a local model stay on your machine — they only go to the server you pick.');
    panel.appendChild(foot);

    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    var servers = SERVERS.slice();
    var app = A();
    if (app) {
      var saved = app.state.settings.providers.custom.baseUrl;
      if (saved && !servers.some(function (s) { return s.url === saved; })) {
        servers.unshift({ name: 'Saved endpoint', url: saved });
      }
    }

    function runScan() {
      results.innerHTML = '';
      results.appendChild(el('div', 'lh-scanning', 'Scanning this machine for local model servers…'));
      renderResults(results, servers);
    }
    rescan.addEventListener('click', runScan);
    addBtn.addEventListener('click', function () {
      var v = addInput.value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(v)) { if (A()) A().toast('Enter a full address, like http://192.168.1.20:11434/v1', true); return; }
      if (!servers.some(function (s) { return s.url === v; })) servers.push({ name: 'Custom server', url: v });
      addInput.value = '';
      runScan();
    });
    addInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });

    runScan();
  }

  window.ToplixLocalHub = { open: open };
})();
