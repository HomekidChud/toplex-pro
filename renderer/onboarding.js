/* Toplix Pro — first-run gate.
 * Step 1: permissions (network access + optional "is ChatGPT / Claude installed?" check).
 * Step 2: sign in with ChatGPT, or connect Claude / any provider with an API key.
 * The app stays locked until both steps are done.
 */
(function () {
  'use strict';
  var CONSENT_KEY = 'toplex.consent';
  var ONBOARDED_KEY = 'toplex.onboarded';
  var CONSENT_VERSION = 1;
  var gate, app, apps = { chatgpt: false, claude: false, cowork: false };
  var autoTried = false;   // auto-connect (installed apps) runs once per gate

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function N() { return window.ToplixNative || { available: false }; }
  function A() { return window.ToplixApp; }

  function readConsent() { try { return JSON.parse(window.ToplixStore.get(CONSENT_KEY) || 'null'); } catch (e) { return null; } }
  function writeConsent(c) { window.ToplixStore.set(CONSENT_KEY, JSON.stringify(Object.assign({ v: CONSENT_VERSION, at: new Date().toISOString() }, c))); }

  function hasCredential() {
    var s = A().state.settings, p = s.providers;
    if (window.ToplixSIWC.active) return true;
    if (['openai', 'anthropic', 'openrouter', 'glm'].some(function (id) { return !!p[id].apiKey; })) return true;
    return !!window.ToplixStore.get(ONBOARDED_KEY);
  }

  function lock(on) {
    gate.hidden = !on;
    document.documentElement.classList.toggle('gate-open', on);
    if (app) { if (on) app.setAttribute('inert', ''); else app.removeAttribute('inert'); }
  }

  function openLink(url) {
    var n = N();
    if (n.available && n.openExternal) n.openExternal(url).catch(function () {});
    else window.open(url, '_blank', 'noopener');
  }

  /* ---------- shared pieces ---------- */
  var ICON = {
    globe: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    apps: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    key: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3"/></svg>'
  };

  function shell(title, sub) {
    gate.innerHTML = '';
    var card = el('div', 'gate-card');
    var brand = el('div', 'gate-brand');
    brand.appendChild(el('span', 'brand-mark', 'T'));
    brand.appendChild(el('span', 'brand-name', 'Toplix Pro'));
    card.appendChild(brand);
    card.appendChild(el('h1', 'gate-title', title));
    if (sub) card.appendChild(el('p', 'gate-sub', sub));
    gate.appendChild(card);
    var help = el('button', 'gate-trouble', 'Something not working? Check this device');
    help.type = 'button';
    help.addEventListener('click', function () { if (window.ToplixDoctor) window.ToplixDoctor.open(); });
    gate.appendChild(help);
    return card;
  }

  function row(icon, title, text, control) {
    var r = el('label', 'gate-row');
    var ic = el('span', 'gate-row-icon'); ic.innerHTML = icon;
    var tx = el('span', 'gate-row-text');
    tx.appendChild(el('span', 'gate-row-title', title));
    tx.appendChild(el('span', 'gate-row-sub', text));
    r.appendChild(ic); r.appendChild(tx);
    if (control) r.appendChild(control);
    return r;
  }

  function toggle(checked, locked) {
    var wrap = el('span', 'gate-switch' + (locked ? ' locked' : ''));
    var cb = el('input'); cb.type = 'checkbox'; cb.checked = checked; cb.disabled = !!locked;
    wrap.appendChild(cb); wrap.appendChild(el('span', 'gate-switch-track'));
    wrap.input = cb;
    return wrap;
  }

  /* ---------- Step 1: permissions ---------- */
  function showPermissions() {
    lock(true);
    var onMobile = N().shell === 'android' || N().shell === 'ios';
    var onDesktop = N().shell === 'electron';
    var card = shell('Before you start', 'Toplix Pro needs your permission for the following. You can change this later in Settings.');

    var net = toggle(true, true);
    card.appendChild(row(ICON.globe, 'Internet access (required)',
      'Sends your messages directly to the AI provider you pick (OpenAI, Anthropic, OpenRouter, Zhipu or your own endpoint) and contacts auth.openai.com to sign in. Nothing is routed through Toplix servers.', net));

    var detect = null;
    if (onMobile || onDesktop) {
      detect = toggle(true, false);
      card.appendChild(row(ICON.apps,
        onDesktop ? 'Look for ChatGPT (Cowork) and Claude 2.0 on this computer' : 'Look for ChatGPT and Claude on this phone',
        onDesktop
          ? 'A simple installed-or-not check. If they are installed, Toplix Pro takes you straight to connecting them. Nothing is read from those apps.'
          : 'A simple installed-or-not check, used to suggest the right sign-in. Nothing is read from those apps.', detect));
    }

    card.appendChild(row(ICON.shield, 'What we never do',
      'Toplix Pro does not watch, capture or read other apps\u2019 network traffic or data. Keys and tokens are stored only on this device.'));

    var actions = el('div', 'gate-actions');
    var allow = el('button', 'btn primary gate-btn', 'Allow and continue');
    var decline = el('button', 'btn ghost gate-btn', 'Don\u2019t allow');
    actions.appendChild(allow); actions.appendChild(decline);
    card.appendChild(actions);

    allow.addEventListener('click', function () {
      writeConsent({ network: true, detectApps: !!(detect && detect.input.checked) });
      next();
    });
    decline.addEventListener('click', function () {
      var c = shell('Internet access is required', 'Toplix Pro is a chat client for online AI models, so it can\u2019t run without network access to the provider you choose.');
      var a = el('div', 'gate-actions');
      var back = el('button', 'btn primary gate-btn', 'Review permissions');
      var quit = el('button', 'btn ghost gate-btn', 'Close Toplix Pro');
      back.addEventListener('click', showPermissions);
      quit.addEventListener('click', function () {
        var capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
        if (capApp && capApp.exitApp) capApp.exitApp(); else window.close();
      });
      a.appendChild(back); a.appendChild(quit); c.appendChild(a);
    });
  }

  /* ---------- Step 2: sign in ---------- */
  function badge(text) { return el('span', 'gate-badge', text); }

  function providerCard(opts) {
    var b = el('button', 'gate-provider');
    b.type = 'button';
    var mark = el('span', 'gate-provider-mark ' + opts.cls, opts.mark);
    var tx = el('span', 'gate-row-text');
    var t = el('span', 'gate-row-title', opts.title);
    if (opts.badge) t.appendChild(badge(opts.badge));
    tx.appendChild(t); tx.appendChild(el('span', 'gate-row-sub', opts.sub));
    b.appendChild(mark); b.appendChild(tx);
    if (opts.disabled) b.disabled = true;
    return b;
  }

  function showSignIn(prefill) {
    lock(true);
    var consent = readConsent() || {};
    var card = shell('Sign in to continue', 'Connect an account or an API key. You\u2019ll only do this once.');
    var error = el('div', 'gate-error'); error.hidden = true;
    var native = N();

    if (consent.detectApps && apps.chatgpt && apps.claude) {
      card.appendChild(el('p', 'gate-hint', 'ChatGPT and Claude are both installed on this phone. Pick the one you want to use.'));
    }

    // ChatGPT
    var chatgpt = providerCard({
      cls: 'chatgpt', mark: 'G', title: 'Continue with ChatGPT',
      badge: consent.detectApps && apps.chatgpt ? (apps.cowork ? 'Cowork installed' : 'App installed') : '',
      sub: (consent.detectApps && apps.chatgpt && apps.cowork)
        ? 'ChatGPT with Cowork is installed on this computer. Approve access in your browser — you are likely already signed in there — and Toplix Pro connects automatically.'
        : (native.available ? 'Use your ChatGPT plan. You\u2019ll approve access in your browser.' : 'Available in the desktop and Android apps.'),
      disabled: !native.available
    });
    card.appendChild(chatgpt);

    // Claude
    var claude = providerCard({
      cls: 'claude', mark: 'C', title: 'Continue with Claude',
      badge: consent.detectApps && apps.claude ? 'Claude 2.0 installed' : '',
      sub: (consent.detectApps && apps.claude)
        ? 'Claude 2.0 is installed on this computer. Anthropic connects third-party apps with an API key, so paste one to connect.'
        : 'Anthropic connects third-party apps with an API key from Console.'
    });
    card.appendChild(claude);

    // API key
    var keyBtn = providerCard({ cls: 'key', mark: '\u2022\u2022', title: 'I have an API key', sub: 'OpenAI, Anthropic, OpenRouter, Zhipu or a custom endpoint.' });
    card.appendChild(keyBtn);

    // Local model on this phone (Android)
    var localBtn = null;
    if (window.ToplixLocal && window.ToplixLocal.available()) {
      localBtn = providerCard({ cls: 'local', mark: 'AI', title: 'Run a model on this phone', badge: 'No account needed',
        sub: 'Download a small model and run it on your phone\u2019s GPU, if you allow it. Works offline.' });
      card.appendChild(localBtn);
    }

    var panel = el('div', 'gate-panel'); panel.hidden = true;
    card.appendChild(panel);
    card.appendChild(error);

    function fail(msg) { error.textContent = msg; error.hidden = false; }
    function clearError() { error.hidden = true; }

    chatgpt.addEventListener('click', function () {
      clearError(); panel.hidden = true;
      chatgpt.disabled = true;
      var wait = el('div', 'gate-waiting');
      wait.appendChild(el('span', 'gate-spinner'));
      var waitMsg = el('span', '', 'Waiting for you to finish in the browser\u2026');
      wait.appendChild(waitMsg);
      var cancel = el('button', 'link-btn', 'Cancel');
      cancel.addEventListener('click', function () { try { native.loopbackStop(); } catch (e) { /* ignore */ } });
      wait.appendChild(cancel);
      panel.innerHTML = ''; panel.appendChild(wait); panel.hidden = false;
      window.ToplixSIWC.signIn(function (m) { waitMsg.textContent = m; }).then(function () {
        finish('Signed in with ChatGPT');
      }).catch(function (e) {
        panel.hidden = true; chatgpt.disabled = false;
        fail(e.message || 'Sign-in failed');
      });
    });

    function keyPanel(preset, note) {
      clearError();
      panel.innerHTML = ''; panel.hidden = false;
      var P = A().PROVIDERS;
      if (note) panel.appendChild(el('p', 'gate-note', note));

      var f1 = el('div', 'gate-field');
      f1.appendChild(el('label', '', 'Provider'));
      var sel = el('select');
      ['openai', 'anthropic', 'openrouter', 'glm', 'custom'].forEach(function (id) {
        var o = el('option', '', P[id].name); o.value = id; if (id === preset) o.selected = true; sel.appendChild(o);
      });
      f1.appendChild(sel); panel.appendChild(f1);

      var f2 = el('div', 'gate-field');
      var keyLabel = el('label', '', 'API key');
      var key = el('input'); key.type = 'password'; key.autocomplete = 'off'; key.autocapitalize = 'off'; key.spellcheck = false;
      f2.appendChild(keyLabel); f2.appendChild(key); panel.appendChild(f2);

      var f3 = el('div', 'gate-field');
      f3.appendChild(el('label', '', 'Base URL (on a phone, use your computer\u2019s Wi-Fi address)'));
      var url = el('input'); url.type = 'url'; f3.appendChild(url); panel.appendChild(f3);

      var help = el('button', 'link-btn gate-help', '');
      help.type = 'button'; panel.appendChild(help);

      var go = el('button', 'btn primary gate-btn', 'Connect');
      panel.appendChild(go);

      var HELP = {
        openai: ['Get an OpenAI key', 'https://platform.openai.com/api-keys'],
        anthropic: ['Get a key from Anthropic Console', 'https://console.anthropic.com/settings/keys'],
        openrouter: ['Get an OpenRouter key', 'https://openrouter.ai/keys'],
        glm: ['Get a Zhipu key', 'https://open.bigmodel.cn/usercenter/apikeys']
      };
      function sync() {
        var id = sel.value, p = P[id];
        key.placeholder = p.keyHint;
        keyLabel.textContent = id === 'custom' ? 'API key (optional)' : 'API key';
        url.value = A().state.settings.providers[id].baseUrl || p.baseUrl;
        f3.hidden = id !== 'custom';
        help.hidden = !HELP[id];
        if (HELP[id]) help.textContent = HELP[id][0];
      }
      sel.addEventListener('change', sync); sync();
      help.addEventListener('click', function () { openLink(HELP[sel.value][1]); });

      go.addEventListener('click', function () {
        clearError();
        var id = sel.value, k = key.value.trim(), base = url.value.trim();
        if (id !== 'custom' && k.length < 8) return fail('Paste your API key to continue.');
        if (id === 'custom' && !/^https?:\/\//.test(base)) return fail('Enter the endpoint URL, for example http://localhost:11434/v1');
        go.disabled = true; go.textContent = 'Checking\u2026';
        verifyKey(id, k, id === 'custom' ? base : P[id].baseUrl).then(function (ok) {
          go.disabled = false; go.textContent = 'Connect';
          if (!ok) return fail('That key was rejected by ' + P[id].name.split(' \u2014 ')[0] + '. Check it and try again.');
          var s = A().state.settings, cfg = s.providers[id];
          cfg.apiKey = k; cfg.authMethod = '';
          if (id === 'custom') cfg.baseUrl = base;
          s.activeProvider = id;
          if (id === 'custom') window.ToplixStore.set(ONBOARDED_KEY, '1');   // custom endpoints may need no key
          A().persist(); A().renderModelMenu(); A().updateModelUI();
          finish('Connected to ' + P[id].name.split(' \u2014 ')[0]);
        });
      });
    }

    if (localBtn) {
      localBtn.addEventListener('click', function () {
        clearError();
        panel.innerHTML = ''; panel.hidden = false;
        panel.appendChild(el('p', 'gate-note', 'Pick a model, download it, then tap Use. You\u2019ll be asked before the GPU is used.'));
        var host = el('div', 'lm-mount');
        panel.appendChild(host);
        window.ToplixLocal.mount(host, { onUse: function () {
          window.ToplixStore.set(ONBOARDED_KEY, '1');
          finish('Local model ready');
        } });
      });
    }

    claude.addEventListener('click', function () {
      keyPanel('anthropic', (apps.claude ? 'Claude 2.0 is installed on this computer, so Claude is preselected. ' : '')
        + 'Anthropic doesn\u2019t allow third-party apps to sign in with a Claude account, so Toplix Pro connects to Claude with an API key. Your usage is billed to that key.');
    });
    keyBtn.addEventListener('click', function () { keyPanel(prefill || 'openai'); });

    // Auto-connect when the ChatGPT (Cowork) or Claude 2.0 apps are installed:
    // ChatGPT starts its one-approval browser sign-in, Claude opens the API key
    // panel with Claude preselected. If neither is installed, the user signs in
    // as usual. Runs once per gate.
    if (consent.detectApps && !autoTried && !hasCredential()) {
      if (apps.chatgpt) {
        autoTried = true;
        var autoNote = el('p', 'gate-hint', 'ChatGPT with Cowork is installed on this computer — connecting it now. Finish the approval in your browser.');
        card.insertBefore(autoNote, chatgpt.nextSibling);
        setTimeout(function () { chatgpt.click(); }, 700);
      } else if (apps.claude) {
        autoTried = true;
        claude.click();
      }
    }
  }

  // Reject only when the provider clearly says the key is bad; stay permissive on network errors.
  function verifyKey(id, key, base) {
    if (id === 'custom' || id === 'glm') return Promise.resolve(true);
    var headers = id === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { Authorization: 'Bearer ' + key };
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 8000);
    return fetch(base + '/models', { headers: headers, signal: ctl.signal })
      .then(function (r) { clearTimeout(t); return !(r.status === 401 || r.status === 403); })
      .catch(function () { clearTimeout(t); return true; });
  }

  /* ---------- flow ---------- */
  function finish(message) {
    lock(false);
    A().toast(message);
  }

  function next() {
    var consent = readConsent();
    if (!consent || consent.v !== CONSENT_VERSION) return showPermissions();
    var detect = consent.detectApps && N().detectApps ? N().detectApps().catch(function () { return {}; }) : Promise.resolve({});
    detect.then(function (r) {
      apps = { chatgpt: !!r.chatgpt, claude: !!r.claude, cowork: !!r.cowork };
      if (hasCredential()) return lock(false);
      showSignIn();
    });
  }

  function start() {
    gate = $('#gate'); app = $('#app');
    if (!gate) return;
    lock(true);           // stay locked until we know the state
    window.ToplixSIWC.restore().then(function (session) {
      var cfg = A().state.settings.providers.openai;
      if (session && session.access_token) A().applyChatGptSession(session);
      else if (cfg.authMethod === 'chatgpt') { cfg.authMethod = ''; cfg.apiKey = ''; A().persist(); }
      // People who already had a key before this gate existed are not asked again
      if (!readConsent() && hasCredential()) writeConsent({ network: true, detectApps: false, legacy: true });
      next();
    });
  }

  window.ToplixOnboarding = { start: start, showPermissions: showPermissions, getConsent: readConsent };
})();
