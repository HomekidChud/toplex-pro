/* Toplix Pro — device diagnostics.
 * Scans this device and the app for problems that would stop it working (network, storage,
 * sign-in, settings, local models and the GPU, app updates), explains each one in plain words,
 * and offers a fix. Nothing is changed until the user reads the list of changes and allows it.
 * Reports never include keys or tokens.
 */
(function () {
  'use strict';

  var REPO = 'HomekidChud/toplex-pro';
  var ERR_KEY = 'toplex.errors';
  var VERSION = (document.querySelector('meta[name="toplix-version"]') || {}).content || '';
  var cap = window.Capacitor;
  var isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  var platform = isNative ? (cap.getPlatform ? cap.getPlatform() : 'android') : (window.toplexNative ? 'desktop' : 'web');

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function A() { return window.ToplixApp; }
  function N() { return window.ToplixNative || {}; }
  function L() { return window.ToplixLocal; }
  function localOn() { return !!(L() && L().available()); }
  function store() { return window.ToplixStore; }
  function mb(n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : Math.round(n) + ' MB'; }
  function timeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error((what || 'The check') + ' took too long')); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* ---------- error log (kept on this device, no keys) ---------- */
  var errors = [];
  try { errors = JSON.parse(store().get(ERR_KEY) || '[]') || []; } catch (e) { errors = []; }
  function noteError(msg, where) {
    msg = String(msg || '').replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…').slice(0, 300);
    if (!msg || /ResizeObserver loop|^Script error\.?$/i.test(msg)) return;
    var last = errors[errors.length - 1];
    if (last && last.m === msg) { last.n++; last.t = Date.now(); }
    else errors.push({ m: msg, w: where || '', t: Date.now(), n: 1 });
    errors = errors.slice(-30);
    try { store().set(ERR_KEY, JSON.stringify(errors)); } catch (e) { /* ignore */ }
  }
  window.addEventListener('error', function (e) {
    noteError((e.message || 'Error') + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : ''), 'script');
  });
  window.addEventListener('unhandledrejection', function (e) {
    noteError((e.reason && e.reason.message) || e.reason || 'A background task failed', 'promise');
  });
  function recentErrors() {
    var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    return errors.filter(function (x) { return x.t > cutoff; });
  }

  /* ---------- finding helpers ---------- */
  function F(id, level, title, detail, fixes) {
    return { id: id, level: level, title: title, detail: detail || '', fixes: fixes || [] };
  }
  function fix(label, describe, run, opts) {
    return { label: label, describe: describe, run: run, risky: !!(opts && opts.risky) };
  }

  function semver(v) {
    var m = String(v || '').replace(/^v/, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    return (m[0] || 0) * 1e6 + (m[1] || 0) * 1e3 + (m[2] || 0);
  }

  function openLink(url) {
    var n = N();
    if (n.available && n.openExternal) return n.openExternal(url);
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  }

  function reach(url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 7000);
    return fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function () { clearTimeout(t); return { ok: true }; }, function (e) { clearTimeout(t); return { ok: false, msg: String((e && e.message) || e) }; });
  }

  /* ---------- checks ---------- */
  function checkDevice(ctx) {
    var lines = [];
    lines.push('Toplix Pro ' + (VERSION || '(unknown version)') + ' on ' + platform);
    var d = ctx.diag;
    if (d) {
      if (d.os) lines.push(d.os);
      if (d.device) lines.push(d.device + (d.soc ? ' (' + d.soc + ')' : ''));
      if (d.ramMb) lines.push('Memory: ' + mb(d.ramMb) + ' total' + (d.availRamMb ? ', ' + mb(d.availRamMb) + ' free' : ''));
      if (d.freeStorageMb !== undefined) lines.push('Free storage: ' + mb(d.freeStorageMb));
      if (d.webview) lines.push('Web engine: ' + d.webview);
      if (d.abis) lines.push('Processor types: ' + d.abis);
    } else {
      lines.push(navigator.userAgent);
    }
    return [F('device', 'ok', 'This device', lines.join('\n'))];
  }

  function checkNetwork(ctx) {
    if (ctx.quick) return [];
    if (navigator.onLine === false) {
      return [F('net-offline', 'error', 'This device says it is offline', 'Turn on Wi-Fi or mobile data. Toplix Pro needs a connection to reach online AI models.')];
    }
    var targets = [
      ['Anthropic (Claude)', 'https://api.anthropic.com'],
      ['OpenAI API', 'https://api.openai.com']
    ];
    if (localOn()) targets.push(['Hugging Face (model downloads)', 'https://huggingface.co']);
    var n = N();
    var jobs = targets.map(function (t) {
      return reach(t[1]).then(function (r) { return { name: t[0], url: t[1], ok: r.ok, msg: r.msg }; });
    });
    // OpenAI sign-in goes through the app's own network layer, so test that same path
    if (n.available && n.http) {
      jobs.push(timeout(n.http({ method: 'GET', url: 'https://auth.openai.com/.well-known/openid-configuration', headers: { Accept: 'application/json' } }), 12000, 'The sign-in server check')
        .then(function (r) { return { name: 'ChatGPT sign-in (auth.openai.com)', ok: r.status > 0 && r.status < 500, msg: 'HTTP ' + r.status }; },
          function (e) { return { name: 'ChatGPT sign-in (auth.openai.com)', ok: false, msg: e.message }; }));
    }
    return Promise.all(jobs).then(function (res) {
      var bad = res.filter(function (r) { return !r.ok; });
      if (!bad.length) return [F('net', 'ok', 'Internet connection', 'Reached ' + res.map(function (r) { return r.name; }).join(', ') + '.')];
      var all = bad.length === res.length;
      var advice = all
        ? 'Nothing could be reached. Check Wi-Fi or mobile data, then turn off any VPN or ad blocker and try again.'
        : 'A VPN, private DNS setting, ad blocker or firewall may be blocking these. Try another network, or turn those off for Toplix Pro.';
      return [F('net', all ? 'error' : 'warn', all ? 'No internet connection' : 'Some services cannot be reached',
        bad.map(function (r) { return r.name + ' — ' + r.msg; }).join('\n') + '\n' + advice)];
    });
  }

  function checkClock(ctx) {
    var n = N();
    if (ctx.quick || !(n.available && n.http)) return [];
    return timeout(n.http({ method: 'GET', url: 'https://api.openai.com/v1/models', headers: { Accept: 'application/json' } }), 12000, 'The clock check')
      .then(function (r) {
        var t = r && r.date ? Date.parse(r.date) : NaN;
        if (isNaN(t)) return [];
        var skew = Date.now() - t;
        if (Math.abs(skew) > 5 * 60 * 1000) {
          var mins = Math.round(Math.abs(skew) / 60000);
          return [F('clock', 'error', 'The date or time on this device is wrong',
            'This device\u2019s clock is about ' + mins + ' minutes ' + (skew > 0 ? 'ahead of' : 'behind') + ' the real time. Sign-in tokens are rejected when the clock is off (this can cause errors such as invalid_grant). Turn on automatic date and time in the device settings. Toplix Pro cannot change the clock for you.')];
        }
        return [F('clock', 'ok', 'Date and time', 'The clock matches the servers.')];
      }, function () { return []; });
  }

  function checkStorageHealth() {
    var out = [];
    var s = store();
    var ok = false;
    try { s.set('__doctor__', '1'); ok = s.get('__doctor__') === '1'; s.remove('__doctor__'); } catch (e) { ok = false; }
    if (!ok) out.push(F('store-rw', 'error', 'Settings and chats cannot be saved', 'This device is blocking local storage, so settings and chats will be lost when the app closes. Free up space or clear the app\u2019s cache in the device settings.'));

    ['toplex.settings', 'toplex.chats'].forEach(function (key) {
      var raw = s.get(key);
      if (!raw) return;
      try { JSON.parse(raw); } catch (e) {
        out.push(F('corrupt-' + key, 'error', key === 'toplex.chats' ? 'Saved chats are damaged' : 'Saved settings are damaged',
          'The saved data could not be read, so the app fell back to defaults.',
          [fix('Reset and keep a backup', 'Copies the damaged ' + (key === 'toplex.chats' ? 'chat history' : 'settings') + ' to a backup entry on this device, then clears it so the app can save fresh data.', function () {
            s.set('toplex.backup.' + key, raw); s.remove(key);
          })]));
      }
    });

    var chats = s.get('toplex.chats') || '';
    if (chats.length > 3500000) {
      out.push(F('chats-big', 'warn', 'Chat history is very large', 'Saved chats use about ' + (chats.length / 1e6).toFixed(1) + ' million characters, close to the browser storage limit. Saving can start failing past that.',
        [fix('Keep only the newest 60 chats', 'Deletes older chats from this device. This cannot be undone.', function () {
          var a = A(); a.state.chats = a.state.chats.slice(0, 60); a.persist();
        }, { risky: true })]));
    }
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate().then(function (e) {
        if (e && e.quota && e.usage / e.quota > 0.9) out.push(F('quota', 'warn', 'App storage is almost full', 'Using ' + mb(e.usage / 1048576) + ' of ' + mb(e.quota / 1048576) + '.'));
        return out;
      }, function () { return out; });
    }
    return out;
  }

  function checkSignIn(ctx) {
    var a = A(); if (!a) return [];
    var out = [];
    var providers = a.state.settings.providers;
    var cfg = providers.openai || {};
    var S = window.ToplixSIWC;

    function reSignIn() {
      return Promise.resolve(S && S.signOut ? S.signOut().catch(function () {}) : null).then(function () {
        cfg.authMethod = ''; cfg.apiKey = ''; a.persist();
        store().remove('toplex.onboarded');
        if (window.ToplixOnboarding) window.ToplixOnboarding.start();
      });
    }

    // Keys: stray spaces/quotes and obvious mix-ups
    Object.keys(providers).forEach(function (id) {
      var p = providers[id];
      if (!p || !p.apiKey || (id === 'openai' && p.authMethod === 'chatgpt')) return;
      var clean = String(p.apiKey).replace(/^[\s"'`]+|[\s"'`]+$/g, '').replace(/\s+/g, '');
      var name = (a.PROVIDERS[id] && a.PROVIDERS[id].name) || id;
      if (clean !== p.apiKey) {
        out.push(F('key-space-' + id, 'warn', 'The ' + name + ' key has stray spaces or quotes', 'Keys pasted from a web page often carry a space, a line break or quote marks. The provider then answers with an authentication error.',
          [fix('Clean up the key', 'Removes spaces, line breaks and quote marks from the saved ' + name + ' key. The key itself is not changed or shown.', function () { p.apiKey = clean; a.persist(); })]));
      }
      if (id === 'anthropic' && clean && clean.indexOf('sk-ant-') !== 0) out.push(F('key-shape-anthropic', 'warn', 'The Claude key looks wrong', 'Claude API keys start with sk-ant-. Create one at console.anthropic.com.'));
      if (id === 'openai' && clean && clean.indexOf('sk-') !== 0) out.push(F('key-shape-openai', 'warn', 'The OpenAI key looks wrong', 'OpenAI API keys start with sk-. Create one at platform.openai.com.'));
    });

    if (cfg.authMethod === 'chatgpt') {
      if (!S || !S.supported) return out;
      if (!S.active) {
        out.push(F('siwc-ended', 'error', 'The ChatGPT sign-in has ended', 'The saved ChatGPT session is no longer valid (it expired or was rejected, for example with invalid_grant). Signing in again creates a fresh one.',
          [fix('Sign out so you can sign in again', 'Signs this device out of ChatGPT, removes the saved session, and opens the sign-in screen.', reSignIn)]));
        return out;
      }
      if (ctx.quick) return out;
      return timeout(S.accessToken(), 15000, 'The sign-in check').then(function () {
        out.push(F('siwc', 'ok', 'ChatGPT sign-in', 'Signed in' + (S.account && S.account.email ? ' as ' + S.account.email : '') + ' and the session refreshes correctly.'));
        return out;
      }, function (e) {
        out.push(F('siwc-bad', 'error', 'The ChatGPT sign-in is not working', String(e.message || e) + '\nIf this keeps happening, sign in again. Also check the date and time on this device.',
          [fix('Sign out so you can sign in again', 'Signs this device out of ChatGPT, removes the saved session, and opens the sign-in screen.', reSignIn)]));
        return out;
      });
    }
    return out;
  }

  function checkSettings(ctx) {
    var a = A(); if (!a) return [];
    var out = [];
    var st = a.state.settings;
    var ap = st.activeProvider;
    var P = a.PROVIDERS;

    function connectedIds() {
      return Object.keys(P).filter(function (id) {
        if (id === 'custom') {
          var c = st.providers.custom || {};
          if (!c.baseUrl || /localhost|127\.0\.0\.1/.test(c.baseUrl)) return false;
        }
        try { return a.isProviderConnected(id); } catch (e) { return false; }
      });
    }

    if (!P[ap]) {
      var alt = connectedIds()[0] || 'openai';
      out.push(F('prov-missing', 'error', 'The selected provider does not exist', 'The saved settings point to a provider that this version does not have.',
        [fix('Switch to ' + ((P[alt] && P[alt].name) || alt), 'Changes the selected provider to ' + ((P[alt] && P[alt].name) || alt) + '.', function () { st.activeProvider = alt; a.persist(); a.renderModelMenu(); a.updateModelUI(); })]));
    } else if (!a.isProviderConnected(ap)) {
      var other = connectedIds().filter(function (id) { return id !== ap; })[0];
      var why = ap === 'device' ? 'No downloaded on-device model is ready to use.' : (ap === 'custom' ? 'The Custom provider has no server address.' : 'No key or sign-in is saved for it.');
      out.push(F('prov-unconnected', 'error', 'The selected provider is not ready: ' + P[ap].name, why + ' Chats would fail until this is fixed.',
        other
          ? [fix('Switch to ' + P[other].name, 'Changes the selected provider to ' + P[other].name + ', which is already connected.', function () { st.activeProvider = other; a.persist(); a.renderModelMenu(); a.updateModelUI(); })]
          : [fix('Open the sign-in screen', 'Shows the sign-in screen so you can connect an account or key. Nothing is deleted.', function () { store().remove('toplex.onboarded'); if (window.ToplixOnboarding) window.ToplixOnboarding.start(); })]));
    } else {
      var cfg = st.providers[ap] || {};
      if (!cfg.model && P[ap].defaultModel) {
        out.push(F('model-empty', 'warn', 'No model is selected', 'The selected provider has no model chosen.',
          [fix('Use ' + P[ap].defaultModel, 'Selects the default model (' + P[ap].defaultModel + ') for ' + P[ap].name + '.', function () { cfg.model = P[ap].defaultModel; a.persist(); a.updateModelUI(); })]));
      }
    }

    var cust = st.providers.custom;
    if (cust && cust.baseUrl) {
      var url = String(cust.baseUrl);
      var u = null;
      try { u = new URL(url.trim()); } catch (e) { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) {
        out.push(F('custom-url', 'error', 'The Custom server address is not valid', 'It must start with http:// or https://, for example http://192.168.1.20:11434/v1.'));
      } else {
        if (url !== url.trim()) out.push(F('custom-url-space', 'warn', 'The Custom server address has spaces around it', '', [fix('Remove the spaces', 'Trims the saved Custom server address.', function () { cust.baseUrl = url.trim(); a.persist(); })]));
        if (isNative && ap === 'custom' && /^(localhost|127\.|\[?::1\]?$)/.test(u.hostname)) {
          out.push(F('custom-local', 'warn', 'The Custom address points at this phone', 'localhost on a phone means the phone itself, not your computer. Use your computer\u2019s Wi-Fi address instead (for example http://192.168.1.20:11434/v1) and start Ollama or LM Studio so it listens on the network.'));
        } else if (!ctx.quick && ap === 'custom') {
          return reach(u.origin, 5000).then(function (r) {
            if (!r.ok) out.push(F('custom-down', 'warn', 'The Custom server did not answer', u.origin + ' could not be reached. Check that the server is running, that this device is on the same network, and that the server listens on the network (for Ollama set OLLAMA_HOST=0.0.0.0).'));
            return out;
          });
        }
      }
    }
    return out;
  }

  function explainGpu(msg, modelId) {
    var m = String(msg || '').toLowerCase();
    var out;
    if (/opencl/.test(m)) out = 'This phone\u2019s graphics driver does not expose OpenCL to apps, which the GPU engine needs. Many mid-range phones are like this.';
    else if (/memory|oom|alloc/.test(m)) out = 'There was not enough free memory to put the model on the GPU. Close other apps or pick a smaller model.';
    else if (/emulator|not supported|unsupported/.test(m)) out = 'The GPU engine says this device or model is not supported. Emulators are not supported.';
    else out = 'The engine reported: ' + String(msg).slice(0, 200);
    if (modelId && !/gemma/.test(modelId)) out += ' This model file is published as a CPU build, so it may simply not be made for the GPU. Gemma 3 1B is the one Google documents for the GPU.';
    return out;
  }

  function checkLocal(ctx) {
    var Lm = L();
    if (!localOn()) return [];
    var nat = Lm.native();
    return timeout(nat.diagnose ? nat.diagnose() : Promise.resolve(null), 20000, 'The model check').then(function (d) {
      d = d || ctx.diag || {};
      var out = [];
      var status = Lm.deviceStatus() || {};
      var installed = Lm.installed();

      if (status && status.supported === false) {
        out.push(F('local-unsupported', 'info', 'This device cannot run on-device models', 'On-device models need a 64-bit ARM phone. You can still use online providers.'));
        return out;
      }

      (d.modelChecks || []).forEach(function (m) {
        if (!m.problem) return;
        out.push(F('model-' + m.id, 'error', 'Downloaded model is damaged: ' + (m.name || m.id), m.problem + ' It would fail to load.',
          [fix('Delete it so you can download it again', 'Deletes the damaged model file from this device (' + (m.name || m.id) + '). You can download it again afterwards.', function () { return nat.remove({ id: m.id }).then(function () { return Lm.refresh(); }); }, { risky: true })]));
      });

      if (d.partialBytes > 20 * 1048576) {
        out.push(F('partials', 'info', 'Unfinished downloads are taking space', mb(d.partialBytes / 1048576) + ' of half-downloaded model files.',
          [fix('Delete unfinished downloads', 'Deletes only half-finished model downloads. Complete models are kept.', function () { return nat.clearPartials(); })]));
      }

      if (d.freeStorageMb !== undefined && d.freeStorageMb < 500) {
        out.push(F('low-storage', d.freeStorageMb < 150 ? 'error' : 'warn', 'This device is low on storage', 'Only ' + mb(d.freeStorageMb) + ' is free. Model downloads are 0.2 to 2 GB and need room to finish.'));
      }
      if (d.lowMemory) out.push(F('low-memory', 'warn', 'This device is short on memory right now', 'Close other apps before loading a model, or it may fail to load.'));
      if (d.powerSave) out.push(F('power-save', 'info', 'Battery saver is on', 'Battery saver slows the processor and GPU, so local models answer more slowly.'));
      if (d.thermal !== undefined && d.thermal >= 3) out.push(F('hot', 'warn', 'This device is running hot', 'It may slow down or stop heavy work until it cools. Let it rest before running a local model.'));

      // models that need more memory than the phone has
      installed.forEach(function (m) {
        var need = { 'qwen2.5-1.5b-instruct': 6, 'gemma3-1b-it': 4, 'qwen2.5-0.5b-instruct': 3 }[m.id];
        if (need && d.ramMb && d.ramMb / 1024 < need - 0.6) {
          out.push(F('ram-' + m.id, 'warn', 'Not enough memory for ' + (m.name || m.id), 'This model works best with about ' + need + ' GB of memory and the device has ' + mb(d.ramMb) + '. It may fail to load or be killed by the system.'));
        }
      });

      // GPU
      var lastErr = Lm.lastGpuError();
      var anyModel = installed[0];
      var gpuOn = Lm.gpuAllowed();
      if (d.gpuBlocked && !gpuOn) {
        out.push(F('gpu-off', 'info', 'The GPU is off', 'It crashed the app earlier, so models run on the CPU. That is stable but slower.',
          [fix('Try the GPU again', 'Clears the crash record and allows the GPU once more. If it crashes again the app closes once and the GPU is switched off again.', function () { return nat.clearGpuBlock().then(function () { Lm.setGpu(true); return Lm.refresh(); }); }, { risky: true })]));
      } else if (d.gpuBlocked) {
        out.push(F('gpu-crashed', 'error', 'The GPU crashed the app earlier',
          'Starting ' + (d.gpuBlockedModel || 'a model') + ' on the GPU closed Toplix Pro, so the GPU is switched off and the CPU is used. The phone\u2019s graphics driver aborted when the GPU engine started, which usually means it does not support it.' + ((d.gpuBlockedModel && !/gemma/.test(d.gpuBlockedModel)) ? ' That model file is also published as a CPU build.' : ''),
          [fix('Keep the GPU off (recommended)', 'Turns the GPU setting off so models run on the CPU. Slower, but stable.', function () { Lm.setGpu(false); }),
            fix('Try the GPU again', 'Clears the crash record and allows the GPU once more. If it crashes again the app closes once and the GPU is switched off again.', function () { return nat.clearGpuBlock().then(function () { return Lm.refresh(); }); }, { risky: true })]));
      } else if (lastErr && gpuOn) {
        out.push(F('gpu-failed', 'warn', 'The GPU could not be used', explainGpu(lastErr.error, lastErr.model) + ' Models run on the CPU instead.',
          [fix('Turn the GPU off', 'Turns the GPU setting off so models go straight to the CPU, without trying the GPU first.', function () { Lm.rememberGpuError(null); Lm.setGpu(false); })]));
      } else if (gpuOn && d.openclLibs && !d.openclLibs.length) {
        out.push(F('gpu-driver', 'warn', 'No GPU compute driver found', 'The OpenCL libraries the GPU engine uses were not found on this phone, so models will most likely run on the CPU.'));
      } else if (gpuOn && anyModel && !(Lm.loadedInfo().backend === 'gpu')) {
        out.push(F('gpu-untested', 'info', 'The GPU has not been tested yet', 'GPU use is allowed, but no model has been started on it yet.',
          [fix('Test the GPU now', 'Starts ' + (anyModel.name || anyModel.id) + ' on the GPU once to see if it works. On some phones a broken GPU driver closes the app; if that happens the GPU is switched off automatically and the next launch will say so.', function () { return Lm.probeGpu(anyModel.id); }, { risky: true })]));
      } else if (gpuOn && Lm.loadedInfo().backend === 'gpu') {
        out.push(F('gpu-ok', 'ok', 'The GPU is working', 'A model is running on the phone\u2019s GPU.'));
      }
      return out;
    }, function (e) {
      return [F('local-check', 'warn', 'Could not check on-device models', String(e.message || e))];
    });
  }

  function checkWebView(ctx) {
    var d = ctx.diag;
    if (!d || !d.webview) return [];
    var m = /(\d+)\.\d+/.exec(d.webview.split(' ').pop() || '');
    var major = m ? parseInt(m[1], 10) : 0;
    if (major && major < 100) {
      return [F('webview', 'warn', 'The web engine is out of date', d.webview + '. Old versions can break parts of the app. Update Android System WebView from the Play Store.',
        [fix('Open the Play Store page', 'Opens the Android System WebView page in your browser or the Play Store. Nothing is installed automatically.', function () { return openLink('https://play.google.com/store/apps/details?id=com.google.android.webview'); })])];
    }
    return [];
  }

  function checkUpdate(ctx) {
    if (ctx.quick || !VERSION) return [];
    return timeout(fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' }), 10000, 'The update check')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var latest = String(j.tag_name || '').replace(/^v/, '');
        if (!latest || semver(latest) <= semver(VERSION)) return [F('update', 'ok', 'Toplix Pro is up to date', 'Version ' + VERSION + ' is the latest release.')];
        var want = platform === 'android' ? /android\.apk$/ : platform === 'ios' ? /\.ipa$/ : /Mac|iPhone/i.test(navigator.platform) ? /\.dmg$/ : /Win/i.test(navigator.platform) ? /\.exe$/ : /\.AppImage$/;
        var asset = (j.assets || []).filter(function (x) { return want.test(x.name); })[0];
        var url = (platform === 'ios' || !asset) ? j.html_url : asset.browser_download_url;
        return [F('update', 'warn', 'A newer version is available: ' + latest, 'You have ' + VERSION + '. Updates install over the top of this version and keep your chats and settings.',
          [fix(platform === 'android' ? 'Open the download' : 'Open the release page', 'Opens ' + url + ' in your browser. Nothing is installed until you open the downloaded file yourself.', function () { return openLink(url); })])];
      }, function () { return []; });
  }

  function checkErrors() {
    var list = recentErrors();
    if (!list.length) return [];
    var total = list.reduce(function (s, x) { return s + x.n; }, 0);
    var hints = [];
    var joined = list.map(function (x) { return x.m; }).join(' | ');
    if (/resolve host|Could not reach|Failed to fetch|NetworkError/i.test(joined)) hints.push('Some errors look like network problems. See the connection check above.');
    if (/invalid_grant/i.test(joined)) hints.push('invalid_grant means ChatGPT rejected the sign-in code or session. Sign in again, and check the device clock.');
    if (/quota|storage/i.test(joined)) hints.push('Some errors mention storage. See the storage checks above.');
    var shown = list.slice(-5).reverse().map(function (x) { return (x.n > 1 ? x.n + 'x ' : '') + x.m; });
    return [F('errors', 'warn', total + ' error' + (total === 1 ? '' : 's') + ' recorded in the last 7 days', shown.join('\n') + (hints.length ? '\n' + hints.join('\n') : ''),
      [fix('Clear the error log', 'Deletes the list of recorded errors from this device. It does not change any settings.', function () { errors = []; store().remove(ERR_KEY); })])];
  }

  function checkNativeShell() {
    if (isNative && !(N().available)) {
      return [F('shell', 'error', 'The app\u2019s built-in helper is missing', 'Sign-in and secure storage need it. Reinstall Toplix Pro from the latest release. Installing over the top keeps your data.')];
    }
    return [];
  }

  /* ---------- scan ---------- */
  var ORDER = { error: 0, warn: 1, info: 2, ok: 3 };

  function scan(opts) {
    var ctx = { quick: !!(opts && opts.quick), diag: null };
    var pre = localOn() && L().native().diagnose
      ? timeout(L().native().diagnose(), 20000, 'The device check').then(function (d) { ctx.diag = d; }, function () {})
      : Promise.resolve();
    return pre.then(function () {
      var checks = [checkNativeShell, checkDevice, checkNetwork, checkClock, checkStorageHealth, checkSignIn, checkSettings, checkLocal, checkWebView, checkUpdate, checkErrors];
      return Promise.all(checks.map(function (fn) {
        return new Promise(function (resolve) { resolve(fn(ctx)); }).then(function (r) { return r || []; }, function (e) {
          return [F('check-' + fn.name, 'warn', 'A check could not run', fn.name.replace('check', '') + ': ' + ((e && e.message) || e))];
        });
      }));
    }).then(function (groups) {
      var all = [].concat.apply([], groups);
      all.sort(function (a, b) { return ORDER[a.level] - ORDER[b.level]; });
      return all;
    });
  }

  function report(findings) {
    var lines = ['Toplix Pro diagnostics', 'Version ' + VERSION + ' on ' + platform, new Date().toISOString(), ''];
    findings.forEach(function (f) {
      lines.push('[' + f.level.toUpperCase() + '] ' + f.title);
      if (f.detail) lines.push('  ' + f.detail.replace(/\n/g, '\n  '));
    });
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  /* ---------- UI ---------- */
  function toast(msg, isErr) { if (A() && A().toast) A().toast(msg, isErr); }

  function askPermission(fixes) {
    return new Promise(function (resolve) {
      var overlay = el('div', 'lm-overlay');
      overlay.style.zIndex = '10002';
      var dlg = el('div', 'lm-dialog');
      dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
      dlg.appendChild(el('h2', 'lm-dialog-title', fixes.length > 1 ? 'Allow Toplix Pro to make these changes?' : 'Allow this change?'));
      dlg.appendChild(el('p', 'lm-dialog-sub', 'Nothing is changed until you allow it. Keys and chats are not read or sent anywhere.'));
      var boxes = [];
      fixes.forEach(function (f) {
        var row = el('label', 'lm-dialog-row dr-fix-row');
        var top = el('div', 'dr-fix-top');
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !f.risky || fixes.length === 1;
        boxes.push({ cb: cb, f: f });
        top.appendChild(cb);
        top.appendChild(el('span', 'lm-dialog-row-title', f.title + ' — ' + f.label));
        row.appendChild(top);
        row.appendChild(el('span', 'lm-dialog-row-sub', f.describe));
        dlg.appendChild(row);
      });
      var actions = el('div', 'lm-dialog-actions');
      var yes = el('button', 'btn primary gate-btn', 'Allow and fix'); yes.type = 'button';
      var no = el('button', 'btn ghost gate-btn', 'Not now'); no.type = 'button';
      actions.appendChild(yes); actions.appendChild(no); dlg.appendChild(actions);
      overlay.appendChild(dlg); document.body.appendChild(overlay);
      yes.focus();
      function done(v) { overlay.remove(); resolve(v); }
      yes.addEventListener('click', function () { done(boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.f; })); });
      no.addEventListener('click', function () { done([]); });
    });
  }

  function runFixes(fixes) {
    var okCount = 0, failures = [];
    return fixes.reduce(function (chain, f) {
      return chain.then(function () {
        return Promise.resolve().then(f.run).then(function () { okCount++; }, function (e) { failures.push(f.title + ': ' + ((e && e.message) || e)); });
      });
    }, Promise.resolve()).then(function () { return { ok: okCount, failures: failures }; });
  }

  var modal = null;

  function open() {
    if (modal) return;
    var overlay = el('div', 'lm-overlay'); overlay.style.zIndex = '10001';
    var dlg = el('div', 'lm-dialog dr-dialog');
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'dr-title');
    var head = el('div', 'dr-head');
    var h = el('h2', 'lm-dialog-title', 'Device diagnostics'); h.id = 'dr-title';
    var close = el('button', 'btn ghost dr-close', 'Close'); close.type = 'button';
    head.appendChild(h); head.appendChild(close);
    dlg.appendChild(head);
    var summary = el('p', 'lm-dialog-sub', 'Checking this device\u2026');
    dlg.appendChild(summary);
    var list = el('div', 'dr-list'); dlg.appendChild(list);
    var foot = el('div', 'dr-foot');
    var fixAll = el('button', 'btn primary', 'Review fixes'); fixAll.type = 'button'; fixAll.hidden = true;
    var again = el('button', 'btn ghost', 'Scan again'); again.type = 'button';
    var copy = el('button', 'btn ghost', 'Copy report'); copy.type = 'button';
    foot.appendChild(fixAll); foot.appendChild(again); foot.appendChild(copy);
    dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    modal = overlay;
    var current = [];
    var scanning = false;

    function shut() { overlay.remove(); modal = null; }
    close.addEventListener('click', shut);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) shut(); });

    function allFixes() {
      var out = [];
      current.forEach(function (f) { if (f.fixes.length) out.push(Object.assign({ title: f.title }, f.fixes[0])); });
      return out;
    }

    function apply(selected) {
      if (!selected.length) return;
      return askPermission(selected).then(function (granted) {
        if (!granted.length) return;
        summary.textContent = 'Applying ' + granted.length + ' fix' + (granted.length === 1 ? '' : 'es') + '\u2026';
        return runFixes(granted).then(function (r) {
          if (r.failures.length) toast('Some fixes did not work: ' + r.failures.join('; '), true);
          else toast(r.ok === 1 ? 'Fixed' : 'Fixed ' + r.ok + ' problems');
          return run();
        });
      });
    }

    function draw() {
      list.innerHTML = '';
      var bad = current.filter(function (f) { return f.level === 'error' || f.level === 'warn'; });
      var errs = current.filter(function (f) { return f.level === 'error'; }).length;
      summary.textContent = bad.length
        ? 'Found ' + bad.length + ' thing' + (bad.length === 1 ? '' : 's') + ' to look at' + (errs ? ' (' + errs + ' serious)' : '') + '. Nothing is changed unless you allow it.'
        : 'No problems found.';
      current.forEach(function (f) {
        var card = el('div', 'dr-item dr-' + f.level);
        var top = el('div', 'dr-item-top');
        top.appendChild(el('span', 'dr-dot'));
        top.appendChild(el('span', 'dr-title', f.title));
        card.appendChild(top);
        if (f.detail) card.appendChild(el('div', 'dr-detail', f.detail));
        if (f.fixes.length) {
          var acts = el('div', 'lm-actions');
          f.fixes.forEach(function (fx, i) {
            var b = el('button', 'btn ' + (i === 0 ? 'primary' : 'ghost'), fx.label); b.type = 'button';
            b.addEventListener('click', function () { apply([Object.assign({ title: f.title }, fx)]); });
            acts.appendChild(b);
          });
          card.appendChild(acts);
        }
        list.appendChild(card);
      });
      var n = allFixes().length;
      fixAll.hidden = n < 2;
      fixAll.textContent = 'Review ' + n + ' fixes';
    }

    function run() {
      if (scanning) return Promise.resolve();
      scanning = true; again.disabled = true;
      summary.textContent = 'Checking this device\u2026';
      return scan().then(function (res) { current = res; draw(); }, function (e) {
        summary.textContent = 'The scan failed: ' + ((e && e.message) || e);
      }).then(function () { scanning = false; again.disabled = false; });
    }

    fixAll.addEventListener('click', function () { apply(allFixes()); });
    again.addEventListener('click', run);
    copy.addEventListener('click', function () {
      copyText(report(current)).then(function () { toast('Report copied. It contains no keys or tokens.'); }, function () { toast('Could not copy the report', true); });
    });
    run();
  }

  /* ---------- background check shortly after start ---------- */
  var bannerShown = false;
  function autoCheck() {
    if (bannerShown) return;
    var gate = document.getElementById('gate');
    if (gate && !gate.hidden) { setTimeout(autoCheck, 6000); return; }
    scan({ quick: true }).then(function (res) {
      var serious = res.filter(function (f) { return f.level === 'error'; });
      if (!serious.length || bannerShown) return;
      bannerShown = true;
      var b = el('div', 'dr-banner'); b.setAttribute('role', 'status');
      b.appendChild(el('span', 'dr-banner-text', 'Toplix Pro found ' + serious.length + ' problem' + (serious.length === 1 ? '' : 's') + ' on this device: ' + serious[0].title));
      var go = el('button', 'btn primary', 'Review'); go.type = 'button';
      var x = el('button', 'btn ghost', 'Dismiss'); x.type = 'button';
      go.addEventListener('click', function () { b.remove(); open(); });
      x.addEventListener('click', function () { b.remove(); });
      b.appendChild(go); b.appendChild(x);
      document.body.appendChild(b);
    }).catch(function () {});
  }
  window.addEventListener('load', function () { setTimeout(autoCheck, 5000); });

  window.ToplixDoctor = { scan: scan, open: open, report: report, noteError: noteError, version: VERSION, platform: platform };
})();
