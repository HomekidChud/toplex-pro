/* Toplix Pro — app.js
 * Chat logic, provider settings, streaming, and UI wiring.
 * Runs both inside Electron (persistent local storage) and on the web preview
 * (storage falls back to memory when the sandbox blocks persistence).
 */
(function () {
  'use strict';

  /* ---------------- Storage (safe in sandboxed iframes too) ---------------- */
  function storeGet(key) {
    return window.ToplixStore.get(key);
  }
  function storeSet(key, value) {
    window.ToplixStore.set(key, value);
  }

  /* ---------------- Providers ---------------- */
  var PROVIDERS = {
    openai: {
      id: 'openai',
      name: 'OpenAI — ChatGPT & Codex',
      desc: 'platform.openai.com API key. GPT-6 family & Codex-optimized models.',
      kind: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      keyHint: 'sk-…',
      models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'],
      defaultModel: 'gpt-6.1-sol'
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic — Claude',
      desc: 'console.anthropic.com API key. Opus, Sonnet & Haiku families.',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      keyHint: 'sk-ant-…',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
      defaultModel: 'claude-sonnet-5-5'
    },
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      desc: 'One key, hundreds of models from every major lab.',
      kind: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      keyHint: 'sk-or-…',
      models: ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5-5', 'google/gemini-3-pro', 'meta-llama/llama-4-maverick'],
      defaultModel: 'anthropic/claude-opus-5-5'
    },
    glm: {
      id: 'glm',
      name: 'Zhipu AI — GLM',
      desc: 'Zhipu (bigmodel.cn) key. GLM-4 family — the same models AI Forge uses.',
      kind: 'openai-chat',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      keyHint: 'paste your key',
      models: ['glm-4.6', 'glm-4.5', 'glm-4-flash', 'glm-4-plus'],
      defaultModel: 'glm-4.6'
    },
    custom: {
      id: 'custom',
      name: 'Custom — OpenAI-compatible',
      desc: 'Any OpenAI-compatible endpoint: Ollama, LM Studio, Groq, Together…',
      kind: 'openai-chat',
      baseUrl: 'http://localhost:11434/v1',
      keyHint: 'optional',
      models: ['llama3.3', 'qwen2.5-coder', 'mistral-large'],
      defaultModel: 'llama3.3'
    }
  };

  var DEFAULT_SETTINGS = {
    activeProvider: 'openai',
    systemPrompt: 'You are Toplix Pro, a senior software engineer. Be concise, correct and practical. Always use markdown code fences with a language tag.',
    temperature: 0.7,
    sendOnEnter: true,
    stream: true,
    mcpServers: [],
    chatgptAuthUrl: '',
    providers: {
      openai: { apiKey: '', model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1' },
      anthropic: { apiKey: '', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com/v1' },
      openrouter: { apiKey: '', model: 'anthropic/claude-opus-5-5', baseUrl: 'https://openrouter.ai/api/v1' },
      glm: { apiKey: '', model: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      custom: { apiKey: '', model: 'llama3.3', baseUrl: 'http://localhost:11434/v1' }
    }
  };

  /* ---------------- State ---------------- */
  var state = {
    settings: loadSettings(),
    chats: loadChats(),
    activeChatId: null,
    generating: false,
    abort: null,
    mcpTools: {},   // serverId -> tool list
    mcpStatus: {}   // serverId -> connect result
  };

  function loadSettings() {
    var raw = storeGet('toplex.settings');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try {
      var s = JSON.parse(raw);
      // merge with defaults so upgrades don't break
      var merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      Object.keys(s || {}).forEach(function (k) { merged[k] = s[k]; });
      Object.keys(DEFAULT_SETTINGS.providers).forEach(function (p) {
        merged.providers[p] = Object.assign({}, DEFAULT_SETTINGS.providers[p], (s.providers || {})[p] || {});
      });
      return merged;
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  }

  function loadChats() {
    var raw = storeGet('toplex.chats');
    if (!raw) return [];
    try { return JSON.parse(raw) || []; } catch (e) { return []; }
  }

  function persist() {
    var toStore = JSON.parse(JSON.stringify(state.settings));
    // Sign in with ChatGPT tokens live in the encrypted native store, never in browser storage
    if (toStore.providers.openai.authMethod === 'chatgpt') toStore.providers.openai.apiKey = '';
    storeSet('toplex.settings', JSON.stringify(toStore));
    storeSet('toplex.chats', JSON.stringify(state.chats.slice(0, 200)));
  }

  function activeChat() {
    return state.chats.find(function (c) { return c.id === state.activeChatId; }) || null;
  }

  function activeProvider() {
    var p = state.settings.activeProvider;
    if (!PROVIDERS[p]) p = 'openai';
    return PROVIDERS[p];
  }

  function providerConfig() {
    return state.settings.providers[activeProvider().id] || state.settings.providers.openai;
  }

  function isProviderConnected(pid) {
    var cfg = state.settings.providers[pid];
    // custom endpoints (Ollama etc.) don't need a key
    if (pid === 'custom') return !!cfg.baseUrl;
    return !!(cfg && cfg.apiKey);
  }

  /* ---------------- DOM helpers ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------------- Toasts ---------------- */
  function toast(message, isError) {
    var last = $('#toast-stack').lastElementChild;
    if (last && last.textContent === message) return; // skip duplicate back-to-back toasts
    var t = el('div', 'toast' + (isError ? ' error' : ''), message);
    $('#toast-stack').appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  /* ---------------- Theme ---------------- */
  (function initTheme() {
    var stored = null;
    stored = window.ToplixStore.get('toplex.theme');
    // Toplix Pro is light-first (T3 Code style); stored preference wins
    var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    var theme = stored || (sysDark && sysDark.matches ? 'dark' : 'light');
    // Follow the system until the user picks a theme themselves
    if (!stored && sysDark && sysDark.addEventListener) {
      sysDark.addEventListener('change', function (ev) {
        if (window.ToplixStore.get('toplex.theme')) return;
        document.documentElement.setAttribute('data-theme', ev.matches ? 'dark' : 'light');
        updateThemeLabel();
        updateThemeIcon();
      });
    }
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeLabel();
    updateThemeIcon();
  })();

  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }

  function updateThemeLabel() {
    var label = $('#theme-label');
    if (label) label.textContent = currentTheme() === 'dark' ? 'Light mode' : 'Dark mode';
  }

  function updateThemeIcon() {
    var btn = $('#theme-toggle');
    if (!btn) return;
    btn.innerHTML = currentTheme() === 'dark'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg><span id="theme-label">Light mode</span>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><span id="theme-label">Dark mode</span>';
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    window.ToplixStore.set('toplex.theme', next);
    updateThemeLabel();
    updateThemeIcon();
  }

  /* ---------------- Sidebar / chat list ---------------- */
  function renderChatList() {
    var list = $('#chat-list');
    list.innerHTML = '';
    var query = ($('#chat-search') && $('#chat-search').value || '').toLowerCase();
    var chats = state.chats.filter(function (c) {
      return !query || c.title.toLowerCase().indexOf(query) !== -1 ||
        c.messages.some(function (m) { return m.content.toLowerCase().indexOf(query) !== -1; });
    });
    if (!state.chats.length) {
      var empty = el('p', 'chat-list-empty', 'No chats yet');
      empty.style.cssText = 'padding:12px;color:var(--color-text-faint);font-size:var(--text-sm);text-align:center;';
      list.appendChild(empty);
      return;
    }
    if (query && !chats.length) {
      var noMatch = el('p', '', 'No chats match "' + query + '"');
      noMatch.style.cssText = 'padding:12px;color:var(--color-text-faint);font-size:var(--text-sm);text-align:center;';
      list.appendChild(noMatch);
      return;
    }
    chats.forEach(function (chat) {
      var item = el('button', 'chat-item' + (chat.id === state.activeChatId ? ' active' : ''));
      item.dataset.testid = 'item-chat-' + chat.id;
      item.setAttribute('aria-label', 'Open chat: ' + chat.title);

      var icon = el('span', '', '');
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      var title = el('span', 'chat-item-title', chat.title);
      var del = el('span', 'chat-delete', '');
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', 'Delete chat');
      del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        deleteChat(chat.id);
      });
      item.appendChild(icon);
      item.appendChild(title);
      item.appendChild(del);
      item.addEventListener('click', function () { openChat(chat.id); });
      list.appendChild(item);
    });
  }

  function newChat() {
    var chat = { id: uid(), title: 'New chat', createdAt: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.activeChatId = chat.id;
    persist();
    renderChatList();
    renderMessages();
    $('#composer-input').focus();
  }

  function openChat(id) {
    if (state.generating) { toast('Wait for the current response to finish', true); return; }
    state.activeChatId = id;
    renderChatList();
    renderMessages();
  }

  function deleteChat(id) {
    state.chats = state.chats.filter(function (c) { return c.id !== id; });
    if (state.activeChatId === id) {
      state.activeChatId = state.chats.length ? state.chats[0].id : null;
    }
    persist();
    renderChatList();
    renderMessages();
  }

  /* ---------------- Messages ---------------- */
  function renderMessages() {
    var container = $('#messages');
    container.innerHTML = '';
    var chat = activeChat();

    var inner = el('div', 'messages-inner');
    container.appendChild(inner);

    if (!chat || !chat.messages.length) {
      inner.appendChild(buildEmptyState());
      $('#chat-title').textContent = 'New chat';
      updateModelUI();
      return;
    }

    $('#chat-title').textContent = chat.title;
    chat.messages.forEach(function (msg, idx) {
      inner.appendChild(buildMessageEl(msg, idx, chat));
    });
    updateModelUI();
    scrollMessages();
  }

  function buildEmptyState() {
    var tpl = document.getElementById('empty-state-tpl');
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelectorAll('.suggestion-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $('#composer-input').value = chip.dataset.prompt;
        sendMessage();
      });
    });
    return node;
  }

  function buildMessageEl(msg, idx, chat) {
    var wrap = el('div', 'msg ' + msg.role);

    if (msg.role === 'user') {
      var role = el('div', 'msg-role');
      role.appendChild(el('span', 'role-avatar', 'You'));
      wrap.appendChild(role);
      var row = el('div', 'msg-user-row');
      var bubble = el('div', 'msg-user-bubble');
      bubble.textContent = msg.content;
      row.appendChild(bubble);
      wrap.appendChild(row);
    } else {
      var roleA = el('div', 'msg-role');
      roleA.appendChild(el('span', 'role-avatar', 'T'));
      roleA.appendChild(el('span', '', msg.modelLabel || 'Assistant'));
      wrap.appendChild(roleA);

      if (msg.error) {
        wrap.appendChild(el('div', 'msg-error', msg.content));
      } else {
        var body = el('div', 'msg-body');
        (msg.toolUses || []).forEach(function (t) {
          var prettyName = (t.rawName || t.name || '').replace(/^toplx_[a-z0-9]+_/i, '');
          body.appendChild(makeToolCard('Used ' + prettyName,
            'Arguments:\n' + JSON.stringify(t.args, null, 2) + '\n\nResult:\n' + t.result));
        });
        var md = el('div', 'msg-md');
        md.innerHTML = window.ToplixMarkdown.render(msg.content);
        wireCopyButtons(md);
        body.appendChild(md);
        wrap.appendChild(body);

        var actions = el('div', 'msg-actions');
        var copyBtn = el('button', 'msg-action', 'Copy');
        copyBtn.dataset.testid = 'button-copy-msg-' + idx;
        copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
        copyBtn.addEventListener('click', function () {
          copyText(msg.content);
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy'; }, 1600);
        });
        actions.appendChild(copyBtn);

        var regen = el('button', 'msg-action', 'Regenerate');
        regen.dataset.testid = 'button-regen-' + idx;
        regen.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg> Regenerate';
        regen.addEventListener('click', function () { regenerate(chat); });
        actions.appendChild(regen);

        wrap.appendChild(actions);
      }
    }
    return wrap;
  }

  function wireCopyButtons(scope) {
    (scope || document).querySelectorAll('.copy-code').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pre = btn.closest('.code-block').querySelector('code');
        copyText(pre.textContent);
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1500);
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function scrollMessages() {
    var container = $('#messages');
    requestAnimationFrame(function () { container.scrollTop = container.scrollHeight; });
  }

  /* ---------------- Model picker ---------------- */
  function renderModelMenu() {
    var menu = $('#model-menu');
    menu.innerHTML = '';
    Object.keys(PROVIDERS).forEach(function (pid) {
      var p = PROVIDERS[pid];
      var cfg = state.settings.providers[pid];
      var group = el('div', 'model-menu-group', p.name);
      menu.appendChild(group);
      p.models.forEach(function (model) {
        var selected = pid === state.settings.activeProvider && model === cfg.model;
        var item = el('button', 'model-menu-item' + (selected ? ' selected' : ''));
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.dataset.testid = 'item-model-' + model.replace(/\//g, '-');
        var name = el('span', 'model-name', model);
        item.appendChild(name);
        if (selected) {
          var check = el('span', 'model-check');
          check.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
          item.appendChild(check);
        }
        item.addEventListener('click', function () {
          state.settings.activeProvider = pid;
          state.settings.providers[pid].model = model;
          persist();
          renderModelMenu();
          updateModelUI();
          $('#model-menu').classList.remove('open');
        });
        menu.appendChild(item);
      });
    });
  }

  function updateModelUI() {
    var p = activeProvider();
    var cfg = providerConfig();
    $('#model-picker-label').textContent = cfg.model || p.defaultModel;
    $('#model-dot').classList.toggle('connected', isProviderConnected(p.id));
    $('#demo-banner').hidden = isProviderConnected(p.id);
    $('#demo-provider-name').textContent = p.name.split('—')[0].trim();
  }

  /* ---------------- Send / generate ---------------- */
  function setGenerating(on) {
    state.generating = on;
    $('#stop-btn').hidden = !on;
    $('#send-btn').disabled = on ? true : !$('#composer-input').value.trim();
    $('#composer-input').disabled = false;
  }

  function sendMessage() {
    var input = $('#composer-input');
    var text = input.value.trim();
    if (!text || state.generating) return;

    if (!state.activeChatId || !activeChat()) newChat();
    var chat = activeChat();

    chat.messages.push({ role: 'user', content: text, ts: Date.now() });
    if (chat.title === 'New chat') {
      chat.title = text.slice(0, 46) + (text.length > 46 ? '…' : '');
    }
    input.value = '';
    autoGrow(input);
    persist();
    renderChatList();
    renderMessages();
    generate(chat);
  }

  function regenerate(chat) {
    if (state.generating) return;
    // remove trailing assistant messages, keep history up to last user message
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') {
      chat.messages.pop();
    }
    if (!chat.messages.length) return;
    persist();
    renderMessages();
    generate(chat);
  }

  function generate(chat) {
    var p = activeProvider();
    var cfg = providerConfig();
    var connected = isProviderConnected(p.id);

    // placeholder assistant message
    var msg = {
      role: 'assistant',
      content: '',
      modelLabel: cfg.model,
      demo: !connected,
      ts: Date.now()
    };
    chat.messages.push(msg);
    persist();
    renderMessages();

    var bodyEl = $('#messages .messages-inner').lastElementChild.querySelector('.msg-body');
    if (!bodyEl) { renderMessages(); bodyEl = $('#messages .messages-inner').lastElementChild.querySelector('.msg-body'); }
    bodyEl.classList.add('stream-cursor');
    setGenerating(true);
    state.abort = new AbortController();

    if (!connected) {
      demoGenerate(msg, bodyEl, chat);
      return;
    }

    // MCP tools connected: run the tool-calling loop (non-streaming rounds)
    if (activeToolDefs().length) {
      toolLoopGenerate(chat, msg, bodyEl);
      return;
    }

    var history = chat.messages
      .filter(function (m) { return !m.error; })
      .map(function (m) { return { role: m.role, content: m.content }; });
    // drop the empty placeholder we just added
    history = history.slice(0, -1);

    var promise;
    if (p.kind === 'openai-responses') promise = streamOpenAIResponses(p, cfg, history, msg, bodyEl);
    else if (p.kind === 'anthropic') promise = streamAnthropic(p, cfg, history, msg, bodyEl);
    else promise = streamOpenAIChat(p, cfg, history, msg, bodyEl);

    promise.then(function () {
      finishGenerate(chat, msg, bodyEl, null);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        msg.content += '\n\n*(stopped)*';
        finishGenerate(chat, msg, bodyEl, null);
      } else {
        finishGenerate(chat, msg, bodyEl, err);
      }
    });
  }

  function finishGenerate(chat, msg, bodyEl, error) {
    bodyEl.classList.remove('stream-cursor');
    setGenerating(false);
    state.abort = null;
    if (error) {
      msg.error = true;
      msg.content = 'Request failed: ' + (error.message || error) +
        '. Check your API key, model name and connection in Settings.';
    }
    if (!msg.content) msg.content = '*(empty response)*';
    persist();
    renderMessages();
  }

  /* ---------------- Demo mode (no API key) ---------------- */
  var DEMO_RESPONSES = [
    'Sure — here is a clean approach.\n\n```python\nimport time\nfrom pathlib import Path\n\ndef watch_folder(folder: str):\n    """Watch a folder and greet every new file."""\n    seen = set()\n    while True:\n        current = {p.name for p in Path(folder).glob("*")}\n        for name in current - seen:\n            print("new file:", name)\n        seen = current\n        time.sleep(1)\n```\n\n**How it works:** the loop polls the folder once a second and diffs the file list. In production you would swap the poll for `watchdog` events, but this version has zero dependencies.\n\nWant me to add CSV → Parquet conversion to it?',
    'Here is the idea, then the code.\n\n1. Identify what re-renders unnecessarily\n2. Wrap expensive subtrees in `memo`\n3. Stabilise callbacks with `useCallback`\n\n```tsx\nconst Row = memo(function Row({ item, onPick }) {\n  return <li onClick={() => onPick(item.id)}>{item.name}</li>;\n});\n```\n\nThis is a demo response — add an API key in **Settings → Models & API keys** to get real answers from GPT-6, Claude or any OpenRouter model.',
    'Short answer: two goroutines race to read-modify-write the same value, and the final state depends on who wins.\n\n```go\nvar counter int64\n\nfunc safeInc() {\n    atomic.AddInt64(&counter, 1) // correct\n}\n```\n\nUse `sync.Mutex` or `atomic` operations. The buggy version (`counter++` from many goroutines) loses updates because the read and the write are not one step.\n\n*(Demo mode — connect a provider in Settings for real answers.)*'
  ];
  var demoIdx = 0;

  function demoGenerate(msg, bodyEl, chat) {
    var text = DEMO_RESPONSES[(demoIdx++) % DEMO_RESPONSES.length];
    var i = 0;
    var step = Math.max(2, Math.round(text.length / 160));
    var timer = setInterval(function () {
      i += step;
      msg.content = text.slice(0, i);
      bodyEl.innerHTML = window.ToplixMarkdown.render(msg.content);
      wireCopyButtons(bodyEl);
      scrollMessages();
      if (i >= text.length) {
        clearInterval(timer);
        finishGenerate(chat, msg, bodyEl, null);
      }
    }, 16);
    state.abort.signal.addEventListener('abort', function () {
      clearInterval(timer);
      finishGenerate(chat, msg, bodyEl, null);
    });
  }

  /* ---------------- SSE helper ---------------- */
  function readSSE(response, onEvent) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return;
        buffer += decoder.decode(result.value, { stream: true });
        var parts = buffer.split('\n');
        buffer = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].trim();
          if (!line.startsWith('data:')) continue;
          var data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try { onEvent(JSON.parse(data)); } catch (e) { /* partial chunk */ }
        }
        return pump();
      });
    }
    return pump();
  }

  function assertOk(response) {
    if (response.ok) return Promise.resolve();
    return response.text().then(function (body) {
      var detail = body;
      try { detail = JSON.parse(body).error?.message || body; } catch (e) {}
      throw new Error('HTTP ' + response.status + (detail ? ' — ' + detail : ''));
    });
  }

  /* ---------------- OpenAI Responses API ---------------- */
  function usingChatGptPlan(cfg) { return cfg.authMethod === 'chatgpt' && window.ToplixSIWC && window.ToplixSIWC.active; }

  // Bearer token: a fresh ChatGPT-plan token when signed in with ChatGPT, otherwise the API key
  function bearerFor(cfg) {
    if (usingChatGptPlan(cfg)) {
      return window.ToplixSIWC.accessToken().then(function (t) { cfg.apiKey = t; return t; });
    }
    return Promise.resolve(cfg.apiKey);
  }

  // Build a Responses API body. ChatGPT-plan requests must use store:false + stream:true,
  // carry the system prompt in `instructions`, and omit unsupported fields.
  function responsesBody(cfg, history, extra, wantStream) {
    var input = history.map(function (m) {
      if (m.type) return m;   // function_call / function_call_output items pass through
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
    });
    var body = { model: cfg.model, input: input };
    if (usingChatGptPlan(cfg)) {
      if (state.settings.systemPrompt) body.instructions = state.settings.systemPrompt;
      body.store = false; body.stream = true;
    } else {
      if (state.settings.systemPrompt) input.unshift({ role: 'system', content: state.settings.systemPrompt });
      if (wantStream) body.stream = true;
    }
    return Object.assign(body, extra || {});
  }

  // Read an SSE stream to the end and return the final response object
  function collectResponse(res) {
    var final = null, text = '';
    return readSSE(res, function (event) {
      if (event.type === 'response.output_text.delta' && event.delta) text += event.delta;
      if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
      if (event.type === 'response.failed') throw new Error((event.response && event.response.error && event.response.error.message) || 'Response failed');
    }).then(function () { return final || { output: [{ content: [{ text: text }] }] }; });
  }

  function streamOpenAIResponses(p, cfg, history, msg, bodyEl) {
    var wantStream = !!state.settings.stream || usingChatGptPlan(cfg);
    return bearerFor(cfg).then(function (token) {
    return fetch(cfg.baseUrl + '/responses', {
      method: 'POST',
      signal: state.abort.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(responsesBody(cfg, history, null, wantStream))
    }); }).then(function (res) {
      return assertOk(res).then(function () {
        if (!wantStream) {
          return res.json().then(function (data) {
            var out = (data.output || []).map(function (o) {
              return (o.content || []).map(function (c) { return c.text || ''; }).join('');
            }).join('');
            msg.content = out;
            bodyEl.innerHTML = window.ToplixMarkdown.render(out);
          });
        }
        return readSSE(res, function (event) {
          if (event.type === 'response.output_text.delta' && event.delta) {
            msg.content += event.delta;
            bodyEl.innerHTML = window.ToplixMarkdown.render(msg.content);
            wireCopyButtons(bodyEl);
            scrollMessages();
          }
          if (event.type === 'error' || (event.response && event.response.error)) {
            throw new Error(event.error?.message || event.response?.error?.message || 'stream error');
          }
        });
      });
    });
  }

  /* ---------------- OpenAI Chat Completions (OpenRouter / custom) ---------------- */
  function streamOpenAIChat(p, cfg, history, msg, bodyEl) {
    var messages = history.map(function (m) { return { role: m.role, content: m.content }; });
    if (state.settings.systemPrompt) messages.unshift({ role: 'system', content: state.settings.systemPrompt });

    return fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      signal: state.abort.signal,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        cfg.apiKey ? { 'Authorization': 'Bearer ' + cfg.apiKey } : {},
        p.id === 'openrouter' ? { 'HTTP-Referer': 'https://toplex.pro', 'X-Title': 'Toplix Pro' } : {}
      ),
      body: JSON.stringify({
        model: cfg.model,
        messages: messages,
        stream: !!state.settings.stream,
        temperature: state.settings.temperature
      })
    }).then(function (res) {
      return assertOk(res).then(function () {
        if (!state.settings.stream) {
          return res.json().then(function (data) {
            var out = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
            msg.content = out;
            bodyEl.innerHTML = window.ToplixMarkdown.render(out);
          });
        }
        return readSSE(res, function (event) {
          var delta = event.choices && event.choices[0] && event.choices[0].delta;
          if (delta && delta.content) {
            msg.content += delta.content;
            bodyEl.innerHTML = window.ToplixMarkdown.render(msg.content);
            wireCopyButtons(bodyEl);
            scrollMessages();
          }
        });
      });
    });
  }

  /* ---------------- Anthropic Messages API ---------------- */
  function streamAnthropic(p, cfg, history, msg, bodyEl) {
    var messages = history.filter(function (m) { return m.role !== 'system'; });
    return fetch(cfg.baseUrl + '/messages', {
      method: 'POST',
      signal: state.abort.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.model,
        system: state.settings.systemPrompt || undefined,
        messages: messages,
        max_tokens: 8192,
        temperature: Math.min(1, state.settings.temperature),
        stream: !!state.settings.stream
      })
    }).then(function (res) {
      return assertOk(res).then(function () {
        if (!state.settings.stream) {
          return res.json().then(function (data) {
            var out = (data.content || []).map(function (c) { return c.text || ''; }).join('');
            msg.content = out;
            bodyEl.innerHTML = window.ToplixMarkdown.render(out);
          });
        }
        return readSSE(res, function (event) {
          if (event.type === 'content_block_delta' && event.delta && event.delta.text) {
            msg.content += event.delta.text;
            bodyEl.innerHTML = window.ToplixMarkdown.render(msg.content);
            wireCopyButtons(bodyEl);
            scrollMessages();
          }
          if (event.type === 'error') {
            throw new Error((event.error && event.error.message) || 'stream error');
          }
        });
      });
    });
  }


  /* ---------------- MCP tools ---------------- */
  function enabledMcpServers() {
    return (state.settings.mcpServers || []).filter(function (s) { return s.enabled !== false; });
  }

  async function refreshMcpTools() {
    var servers = enabledMcpServers();
    state.mcpTools = {};
    state.mcpStatus = {};
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var res = await window.ToplixMCP.connect(s);
      state.mcpStatus[s.id] = res;
      if (res.ok) state.mcpTools[s.id] = res.tools;
    }
    // refresh status text if settings modal is open
    if (!$('#settings-overlay').hidden && document.querySelector('[data-pane="connectors"]').classList.contains('active')) {
      renderMcpSettings();
    }
  }

  function activeToolDefs() {
    return window.ToplixMCP.toolDefs(enabledMcpServers(), state.mcpTools);
  }

  function serverById(id) {
    return (state.settings.mcpServers || []).find(function (s) { return s.id === id; });
  }

  function makeToolCard(title, bodyText) {
    var tpl = document.getElementById('tool-card-tpl');
    var card = tpl.content.firstElementChild.cloneNode(true);
    card.querySelector('.tool-card-title').textContent = title;
    card.querySelector('.tool-card-body').textContent = bodyText;
    card.querySelector('.tool-card-toggle').addEventListener('click', function () {
      card.classList.toggle('open');
      card.querySelector('.tool-card-toggle').textContent = card.classList.contains('open') ? 'Hide' : 'Details';
    });
    return card;
  }

  /* Non-streaming request WITH tools; returns {text, toolCalls:[{name, rawName, server, args, callId}]} */
  async function requestWithTools(p, cfg, history, defs) {
    if (p.kind === 'openai-responses') return openaiResponsesTools(p, cfg, history, defs);
    if (p.kind === 'anthropic') return anthropicTools(p, cfg, history, defs);
    return openaiChatTools(p, cfg, history, defs);
  }

  async function openaiResponsesTools(p, cfg, history, defs) {
    var token = await bearerFor(cfg);
    var res = await fetch(cfg.baseUrl + '/responses', {
      method: 'POST', signal: state.abort.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(responsesBody(cfg, history, {
        tools: defs.map(function (d) {
          return { type: 'function', name: d.name, description: d.description, parameters: d.input_schema, strict: false };
        })
      }, false))
    });
    await assertOk(res);
    var data = usingChatGptPlan(cfg) ? await collectResponse(res) : await res.json();
    var toolCalls = [];
    var text = '';
    (data.output || []).forEach(function (item) {
      if (item.type === 'function_call') {
        var def = defs.find(function (d) { return d.name === item.name; });
        var args = {};
        try { args = JSON.parse(item.arguments || '{}'); } catch (e) {}
        toolCalls.push({
          name: item.name, rawName: def ? def._tool : item.name,
          server: def ? serverById(def._server) : null,
          args: args, callId: item.call_id, kind: 'responses'
        });
      }
      if (item.type === 'message') {
        (item.content || []).forEach(function (c) { if (c.text) text += c.text; });
      }
    });
    return { text: text, toolCalls: toolCalls };
  }

  async function anthropicTools(p, cfg, history, defs) {
    var messages = history.filter(function (m) { return m.role !== 'system' && !m._raw; });
    var res = await fetch(cfg.baseUrl + '/messages', {
      method: 'POST', signal: state.abort.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.model,
        system: state.settings.systemPrompt || undefined,
        messages: messages,
        max_tokens: 8192,
        temperature: Math.min(1, state.settings.temperature),
        tools: defs.map(function (d) {
          return { name: d.name, description: d.description, input_schema: d.input_schema };
        })
      })
    });
    await assertOk(res);
    var data = await res.json();
    var toolCalls = [];
    var text = '';
    (data.content || []).forEach(function (block) {
      if (block.type === 'tool_use') {
        var def = defs.find(function (d) { return d.name === block.name; });
        toolCalls.push({
          name: block.name, rawName: def ? def._tool : block.name,
          server: def ? serverById(def._server) : null,
          args: block.input || {}, callId: block.id, kind: 'anthropic'
        });
      }
      if (block.type === 'text') text += block.text;
    });
    return { text: text, toolCalls: toolCalls };
  }

  async function openaiChatTools(p, cfg, history, defs) {
    var messages = history.map(function (m) { return { role: m.role, content: m.content }; });
    if (state.settings.systemPrompt) messages.unshift({ role: 'system', content: state.settings.systemPrompt });
    var res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST', signal: state.abort.signal,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        cfg.apiKey ? { 'Authorization': 'Bearer ' + cfg.apiKey } : {},
        p.id === 'openrouter' ? { 'HTTP-Referer': 'https://toplex.pro', 'X-Title': 'Toplix Pro' } : {}
      ),
      body: JSON.stringify({
        model: cfg.model, messages: messages,
        temperature: state.settings.temperature,
        tools: defs.map(function (d) {
          return { type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema } };
        })
      })
    });
    await assertOk(res);
    var data = await res.json();
    var m = data.choices && data.choices[0] && data.choices[0].message;
    var toolCalls = [];
    ((m && m.tool_calls) || []).forEach(function (tc) {
      var def = defs.find(function (d) { return d.name === tc.function.name; });
      var args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      toolCalls.push({
        name: tc.function.name, rawName: def ? def._tool : tc.function.name,
        server: def ? serverById(def._server) : null,
        args: args, callId: tc.id, kind: 'chat'
      });
    });
    return { text: (m && m.content) || '', toolCalls: toolCalls };
  }

  function appendToolResultToHistory(history, call, resultText) {
    if (call.kind === 'responses') {
      history.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: JSON.stringify(call.args) });
      history.push({ type: 'function_call_output', call_id: call.callId, output: resultText });
    } else if (call.kind === 'anthropic') {
      history.push({ role: 'assistant', content: [{ type: 'tool_use', id: call.callId, name: call.name, input: call.args }] });
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.callId, content: resultText }] });
    } else {
      history.push({ role: 'assistant', content: null, tool_calls: [{ id: call.callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
      history.push({ role: 'tool', tool_call_id: call.callId, content: resultText });
    }
  }

  async function toolLoopGenerate(chat, msg, bodyEl) {
    try {
      var p = activeProvider();
      var cfg = providerConfig();
      var defs = activeToolDefs();
      var history = chat.messages
        .filter(function (m) { return !m.error; })
        .map(function (m) { return { role: m.role, content: m.content }; })
        .slice(0, -1);
      var rounds = 0, maxRounds = 6;
      while (rounds < maxRounds) {
        rounds++;
        bodyEl.innerHTML = window.ToplixMarkdown.render('_(using connected tools)_');
        var res = await requestWithTools(p, cfg, history, defs);
        if (!res.toolCalls.length) {
          msg.content = res.text || '*(empty response)*';
          break;
        }
        for (var i = 0; i < res.toolCalls.length; i++) {
          var c = res.toolCalls[i];
          msg.toolUses = msg.toolUses || [];
          var card = makeToolCard('Using ' + c.rawName, 'Arguments:\n' + JSON.stringify(c.args, null, 2) + '\n\nRunning…');
          bodyEl.innerHTML = '';
          bodyEl.appendChild(card);
          scrollMessages();
          var resultText;
          try {
            var tr = c.server
              ? await window.ToplixMCP.callTool(c.server, c.rawName, c.args)
              : { content: [{ type: 'text', text: '(tool server unavailable)' }], isError: true };
            resultText = window.ToplixMCP.resultToText(tr);
            if (tr && tr.isError) resultText = 'Tool error: ' + resultText;
          } catch (e) {
            resultText = 'Tool error: ' + e.message;
          }
          msg.toolUses.push({ name: c.name, rawName: c.rawName, args: c.args, result: resultText });
          card.querySelector('.tool-card-body').textContent = 'Arguments:\n' + JSON.stringify(c.args, null, 2) + '\n\nResult:\n' + resultText;
          appendToolResultToHistory(history, c, resultText);
        }
      }
      if (rounds >= maxRounds && !msg.content) msg.content = '*(stopped — too many tool rounds)*';
      finishGenerate(chat, msg, bodyEl, null);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        msg.content += '\n\n*(stopped)*';
        finishGenerate(chat, msg, bodyEl, null);
      } else {
        finishGenerate(chat, msg, bodyEl, err);
      }
    }
  }

  /* ---------------- Sign in with ChatGPT ---------------- */
  function applyChatGptSession(session) {
    var cfg = state.settings.providers.openai;
    if (session && session.access_token) {
      cfg.authMethod = 'chatgpt';
      cfg.apiKey = session.access_token;
      state.settings.activeProvider = 'openai';
      refreshChatGptModels();
    } else if (cfg.authMethod === 'chatgpt') {
      cfg.authMethod = '';
      cfg.apiKey = '';
    }
    persist();
    renderModelMenu();
    updateModelUI();
    updateChatGptStatus();
  }

  function refreshChatGptModels() {
    window.ToplixSIWC.listModels().then(function (models) {
      if (!models.length) return;
      PROVIDERS.openai.models = models.map(function (m) { return m.slug; });
      var cfg = state.settings.providers.openai;
      if (PROVIDERS.openai.models.indexOf(cfg.model) === -1) cfg.model = PROVIDERS.openai.models[0];
      persist(); renderModelMenu(); updateModelUI();
    }).catch(function () { /* keep the built-in list */ });
  }

  function updateChatGptStatus() {
    var statusEl = $('#chatgpt-auth-status');
    var btn = $('#chatgpt-signin');
    if (!statusEl || !btn) return;
    var siwc = window.ToplixSIWC, openaiCfg = state.settings.providers.openai;
    if (siwc && siwc.active) {
      var acct = siwc.account || {};
      statusEl.textContent = 'Signed in with ChatGPT' + (acct.email ? ' as ' + acct.email : '') + ' — using your ChatGPT plan';
      btn.textContent = 'Sign out';
    } else {
      statusEl.textContent = openaiCfg.apiKey ? 'Using an OpenAI API key (Models tab)' : 'Not signed in — or paste an OpenAI API key on the Models tab.';
      btn.textContent = 'Continue with ChatGPT';
    }
    btn.disabled = !(siwc && siwc.supported);
    btn.title = btn.disabled ? 'Available in the desktop and Android apps' : '';
  }

  function onChatGptButton() {
    var siwc = window.ToplixSIWC;
    if (siwc.active) {
      siwc.signOut().then(function () { toast('Signed out of ChatGPT'); });
      return;
    }
    $('#chatgpt-signin').disabled = true;
    toast('Finish signing in in your browser…');
    siwc.signIn().then(function () { toast('ChatGPT account connected'); })
      .catch(function (e) { toast(e.message, true); })
      .then(updateChatGptStatus);
  }

  /* ---------------- MCP settings UI ---------------- */
  function renderMcpSettings() {
    var list = $('#mcp-server-list');
    list.innerHTML = '';
    (state.settings.mcpServers || []).forEach(function (s) {
      var row = el('div', 'mcp-server-row');
      var icon = el('div', 'mcp-server-icon');
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
      var meta = el('div', 'mcp-server-meta');
      meta.appendChild(el('div', 'mcp-server-name', s.name));
      var urlEl = el('div', 'mcp-server-url', s.url);
      meta.appendChild(urlEl);
      var status = el('div', 'mcp-server-status');
      var st = state.mcpStatus[s.id];
      if (st && st.ok) {
        status.className = 'mcp-server-status on';
        status.textContent = st.tools.length === 1 ? '1 tool' : st.tools.length + ' tools';
      } else if (st && st.error) {
        status.className = 'mcp-server-status err';
        status.textContent = 'Error';
        status.title = st.error;
      } else {
        status.textContent = 'Not connected';
      }
      var remove = el('button', 'icon-btn mcp-server-remove');
      remove.setAttribute('aria-label', 'Remove server');
      remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      remove.addEventListener('click', function () {
        state.settings.mcpServers = (state.settings.mcpServers || []).filter(function (x) { return x.id !== s.id; });
        persist();
        renderMcpSettings();
        refreshMcpTools();
        toast('MCP server removed');
      });
      row.appendChild(icon); row.appendChild(meta); row.appendChild(status); row.appendChild(remove);
      list.appendChild(row);
    });
    if (!(state.settings.mcpServers || []).length) {
      var empty = el('p', '', 'No MCP servers yet — add one below.');
      empty.style.cssText = 'padding:4px 16px;color:var(--color-text-faint);font-size:var(--text-sm)';
      list.appendChild(empty);
    }
  }

  /* ---------------- Settings modal ---------------- */
  function openSettings() {
    // build provider cards
    var cards = $('#provider-cards');
    cards.innerHTML = '';
    Object.keys(PROVIDERS).forEach(function (pid) {
      var p = PROVIDERS[pid];
      var cfg = state.settings.providers[pid];

      var card = el('div', 'provider-card' + (pid === state.settings.activeProvider ? ' active' : ''));
      card.dataset.provider = pid;

      var top = el('div', 'provider-card-top');
      var logo = el('div', 'provider-logo', p.name.split(' ')[0].slice(0, 2).toUpperCase());
      var meta = el('div', 'provider-meta');
      meta.appendChild(el('div', 'provider-name', p.name));
      meta.appendChild(el('div', 'provider-desc', p.desc));
      var status = el('div', 'provider-status' + (isProviderConnected(pid) ? ' on' : ''), '');
      status.appendChild(el('span', 'status-dot'));
      status.appendChild(document.createTextNode(isProviderConnected(pid) ? 'Connected' : 'Not set'));
      top.appendChild(logo); top.appendChild(meta); top.appendChild(status);
      card.appendChild(top);

      var fields = el('div', 'provider-fields');
      var keyWrap = el('div', 'field-row span-2 key-wrap');
      var keyLabel = el('label', '', 'API key');
      keyLabel.setAttribute('for', 'key-' + pid);
      var keyInput = el('input');
      keyInput.type = 'password'; keyInput.id = 'key-' + pid;
      keyInput.placeholder = p.keyHint;
      if (pid === 'openai' && cfg.authMethod === 'chatgpt') { keyInput.value = ''; keyInput.placeholder = 'Signed in with ChatGPT'; keyInput.disabled = true; }
      else keyInput.value = cfg.apiKey || '';
      keyInput.dataset.testid = 'input-key-' + pid;
      keyInput.autocomplete = 'off';
      var reveal = el('button', 'key-reveal', 'Show');
      reveal.type = 'button';
      reveal.addEventListener('click', function () {
        var hidden = keyInput.type === 'password';
        keyInput.type = hidden ? 'text' : 'password';
        reveal.textContent = hidden ? 'Hide' : 'Show';
      });
      keyWrap.appendChild(keyLabel); keyWrap.appendChild(keyInput); keyWrap.appendChild(reveal);

      var modelField = el('div', 'field-row');
      var modelLabel = el('label', '', 'Model');
      modelLabel.setAttribute('for', 'model-' + pid);
      var modelInput = el('input');
      modelInput.type = 'text'; modelInput.id = 'model-' + pid; modelInput.value = cfg.model;
      modelInput.placeholder = p.defaultModel;
      modelInput.setAttribute('list', 'models-' + pid);
      var datalist = el('datalist'); datalist.id = 'models-' + pid;
      p.models.forEach(function (m) { datalist.appendChild(el('option', '', m)); });
      modelField.appendChild(modelLabel); modelField.appendChild(modelInput); modelField.appendChild(datalist);

      var urlField = el('div', 'field-row');
      var urlLabel = el('label', '', 'Base URL');
      urlLabel.setAttribute('for', 'url-' + pid);
      var urlInput = el('input');
      urlInput.type = 'text'; urlInput.id = 'url-' + pid; urlInput.value = cfg.baseUrl;
      urlInput.placeholder = p.baseUrl;
      urlField.appendChild(urlLabel); urlField.appendChild(urlInput);

      fields.appendChild(keyWrap); fields.appendChild(modelField); fields.appendChild(urlField);
      card.appendChild(fields);

      var activate = el('button', 'btn ghost');
      activate.textContent = pid === state.settings.activeProvider ? '✓ Active provider' : 'Use this provider';
      activate.style.marginTop = 'var(--space-3)';
      activate.dataset.testid = 'button-activate-' + pid;
      activate.addEventListener('click', function () {
        state.settings.activeProvider = pid;
        openSettings();
        persist();
        updateModelUI();
      });
      card.appendChild(activate);

      cards.appendChild(card);
    });

    document.querySelectorAll('.settings-tab').forEach(function (tab) {
      var on = tab.classList.contains('active');
      if (on) $('#settings-crumb').textContent = tab.textContent;
    });
    $('#setting-dark').checked = currentTheme() === 'dark';
    updateChatGptStatus();
    renderMcpSettings();
    $('#setting-system').value = state.settings.systemPrompt;
    $('#setting-temp').value = state.settings.temperature;
    $('#temp-value').textContent = state.settings.temperature;
    $('#setting-enter').checked = state.settings.sendOnEnter;
    $('#setting-stream').checked = state.settings.stream;

    $('#settings-overlay').hidden = false;
  }

  function closeSettings() { $('#settings-overlay').hidden = true; }

  function saveSettings() {
    Object.keys(PROVIDERS).forEach(function (pid) {
      var cfg = state.settings.providers[pid];
      var keyEl = $('#key-' + pid);
      var modelEl = $('#model-' + pid);
      var urlEl = $('#url-' + pid);
      if (keyEl && !keyEl.disabled) { cfg.apiKey = keyEl.value.trim(); if (pid === 'openai' && cfg.apiKey) cfg.authMethod = ''; }
      if (modelEl) cfg.model = modelEl.value.trim() || PROVIDERS[pid].defaultModel;
      if (urlEl) cfg.baseUrl = urlEl.value.trim() || PROVIDERS[pid].baseUrl;
    });
    state.settings.systemPrompt = $('#setting-system').value;
    state.settings.temperature = parseFloat($('#setting-temp').value);
    state.settings.sendOnEnter = $('#setting-enter').checked;
    state.settings.stream = $('#setting-stream').checked;
    var wantDark = $('#setting-dark').checked;
    if (wantDark !== (currentTheme() === 'dark')) toggleTheme();
    persist();
    refreshMcpTools();
    closeSettings();
    updateModelUI();
    renderModelMenu();
    toast('Settings saved');
  }

  function resetAppData() {
    if (!window.confirm('Delete all chats, API keys and settings? This cannot be undone.')) return;
    window.ToplixStore.remove('toplex.settings');
    window.ToplixStore.remove('toplex.chats');
    window.ToplixStore.remove('toplex.theme');
    state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    state.chats = [];
    state.activeChatId = null;
    closeSettings();
    renderChatList();
    renderMessages();
    renderModelMenu();
    updateModelUI();
    toast('App data reset');
  }

  /* ---------------- Composer helpers ---------------- */
  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }

  /* ---------------- Wire up ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    renderChatList();
    renderMessages();
    renderModelMenu();
    updateModelUI();

    $('#new-chat-btn').addEventListener('click', newChat);
    $('#chat-search').addEventListener('input', renderChatList);
    $('#sidebar-collapse').addEventListener('click', function () { $('#app').classList.add('sidebar-hidden'); });
    $('#sidebar-expand').addEventListener('click', function () { $('#app').classList.remove('sidebar-hidden'); });
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#open-settings').addEventListener('click', openSettings);
    $('#open-settings-top').addEventListener('click', openSettings);
    $('#demo-open-settings').addEventListener('click', openSettings);
    $('#demo-close').addEventListener('click', function () { $('#demo-banner').hidden = true; });

    $('#model-picker-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = $('#model-menu');
      var open = menu.classList.toggle('open');
      $('#model-picker-btn').setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', function () { $('#model-menu').classList.remove('open'); });

    $('#send-btn').addEventListener('click', sendMessage);
    $('#stop-btn').addEventListener('click', function () {
      if (state.abort) state.abort.abort();
    });

    var input = $('#composer-input');
    input.addEventListener('input', function () {
      autoGrow(input);
      $('#send-btn').disabled = state.generating || !input.value.trim();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && state.settings.sendOnEnter) {
        e.preventDefault();
        sendMessage();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
    });

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault(); newChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault(); openSettings();
      }
      if (e.key === 'Escape') {
        if (!$('#settings-overlay').hidden) closeSettings();
        else if (state.generating && state.abort) state.abort.abort();
      }
    });

    // Settings modal
    $('#settings-close').addEventListener('click', closeSettings);
    $('#settings-cancel').addEventListener('click', closeSettings);
    $('#settings-save').addEventListener('click', saveSettings);
    $('#settings-reset').addEventListener('click', resetAppData);
    $('#settings-overlay').addEventListener('click', function (e) {
      if (e.target === $('#settings-overlay')) closeSettings();
    });

    document.querySelectorAll('.settings-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.settings-tab').forEach(function (t) {
          t.classList.toggle('active', t === tab);
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });
        document.querySelectorAll('.settings-pane').forEach(function (pane) {
          pane.classList.toggle('active', pane.dataset.pane === tab.dataset.tab);
        });
        $('#settings-crumb').textContent = tab.textContent;
      });
    });

    $('#setting-temp').addEventListener('input', function (e) {
      $('#temp-value').textContent = e.target.value;
    });

    // Sign in with ChatGPT
    $('#chatgpt-signin').addEventListener('click', onChatGptButton);
    window.ToplixSIWC.onChange(applyChatGptSession);

    // MCP server management
    $('#mcp-add-btn').addEventListener('click', function () {
      var name = $('#mcp-add-name').value.trim() || 'Server';
      var url = $('#mcp-add-url').value.trim();
      if (!/^https?:\/\//.test(url)) { toast('Enter a valid http(s) MCP URL', true); return; }
      var apiKey = $('#mcp-add-key').value.trim();
      if (!state.settings.mcpServers) state.settings.mcpServers = [];
      state.settings.mcpServers.push({ id: uid(), name: name, url: url, apiKey: apiKey });
      $('#mcp-add-name').value = ''; $('#mcp-add-url').value = ''; $('#mcp-add-key').value = '';
      persist();
      renderMcpSettings();
      refreshMcpTools();
      toast('MCP server added');
    });

    // Connect MCP servers on launch
    refreshMcpTools();

    // Drawer / placeholder / layout adaptation lives in adaptive.js

    // Hand control to the first-run gate (permissions + sign-in) before the app can be used
    window.ToplixApp = {
      state: state, PROVIDERS: PROVIDERS, persist: persist, toast: toast,
      renderModelMenu: renderModelMenu, updateModelUI: updateModelUI,
      applyChatGptSession: applyChatGptSession, isProviderConnected: isProviderConnected
    };
    if (window.ToplixOnboarding) window.ToplixOnboarding.start();

    // Start with an empty chat view
    if (!state.chats.length) {
      updateModelUI();
    }
  });
})();
