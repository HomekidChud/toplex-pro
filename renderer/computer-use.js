/* Toplix Pro — computer-use mode (desktop only).
 * The strict safety rules (approved folders or user-enabled full access,
 * credentials always blocked, approval dialog for every write/command/app
 * launch in manual mode — or auto "approve for me" mode — blocked dangerous
 * commands, audit log) are enforced in the Electron main process. This file
 * only exposes the tools to the model and relays calls.
 *
 * The AI also gets its own Chromium browser ("AI Browser") with tabs, its own
 * visible mouse cursor, and the ability to open apps on this computer.
 */
(function () {
  'use strict';
  var bridge = window.toplexComputer || null;

  var state = { enabled: false, roots: [], platform: '', approvalMode: 'manual', fullAccess: false };

  function refresh() {
    if (!bridge) return Promise.resolve();
    return bridge.status().then(function (s) {
      state.enabled = !!s.enabled;
      state.roots = s.roots || [];
      state.platform = s.platform;
      state.approvalMode = s.approvalMode || 'manual';
      state.fullAccess = !!s.fullAccess;
      return s;
    });
  }

  /* Tool definitions handed to the model in computer-use mode. */
  function toolDefs() {
    return [
      {
        _computer: true,
        name: 'computer_list_files',
        description: 'List the contents of a folder on the user\'s computer. Works inside approved folders, or anywhere if the user enabled full computer access.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute folder path' } },
          required: ['path']
        }
      },
      {
        _computer: true,
        name: 'computer_read_file',
        description: 'Read a text file (up to 256 KB). Works inside approved folders, or anywhere if the user enabled full computer access.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute file path' } },
          required: ['path']
        }
      },
      {
        _computer: true,
        name: 'computer_write_file',
        description: 'Write a file. In manual approval mode the user sees a dialog with the target path before anything is written; in "approve for me" (auto) mode it is approved automatically. Credentials are always blocked.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file path to write' },
            content: { type: 'string', description: 'Full file content to write' }
          },
          required: ['path', 'content']
        }
      },
      {
        _computer: true,
        name: 'computer_run_command',
        description: 'Run a shell command. Never elevated (sudo blocked), destructive commands blocked, killed after 60 seconds. Manual approval mode shows a dialog first; auto mode approves for the user. Every run is audit-logged.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to run' },
            cwd: { type: 'string', description: 'Folder to run it in (an approved folder, or any folder with full access)' }
          },
          required: ['command', 'cwd']
        }
      },
      {
        _computer: true,
        name: 'computer_list_apps',
        description: 'List the apps installed on this computer, with the exact names to use with computer_open_app.',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        _computer: true,
        name: 'computer_open_app',
        description: 'Open an app on this computer by name (e.g. "Calculator", "VS Code"). The user approves this in manual mode. Use computer_list_apps first if you are not sure of the name.',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'App name as shown by computer_list_apps' } },
          required: ['name']
        }
      },
      {
        _computer: true,
        name: 'computer_open_url',
        description: 'Open a URL. By default it opens in your own AI Browser (embedded Chromium); pass where:"default" to use the user\'s default browser instead (that needs approval in manual mode).',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to open' },
            where: { type: 'string', enum: ['browser', 'default'], description: '"browser" (AI Browser, default) or "default" (user\'s browser)' }
          },
          required: ['url']
        }
      },
      {
        _computer: true,
        name: 'browser_open',
        description: 'Open a website in your own AI Browser (an embedded Chromium window the user can watch). You get your own mouse cursor there — the user\'s real mouse is never touched. Non-URL input is searched on DuckDuckGo.',
        input_schema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL or search terms' } },
          required: ['url']
        }
      },
      {
        _computer: true,
        name: 'browser_read_page',
        description: 'Read the active AI Browser page: title, URL, visible text (up to 12,000 chars), the first links, and a list of clickable elements with their exact x,y coordinates (tag "text" @ x,y). Use this after navigating or clicking to see what the page says — and use the listed element coordinates with browser_click.',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        _computer: true,
        name: 'browser_screenshot',
        description: 'Save a PNG screenshot of the active AI Browser page and get its file path — this is for the USER to look at; you cannot see images. To understand or act on the page, use browser_read_page (it gives you clickable elements with x,y coordinates) or browser_click_selector instead.',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        _computer: true,
        name: 'browser_click',
        description: 'Move your own AI cursor to x,y and click there in the AI Browser. The user sees the cursor move and a click ripple. Get x,y from browser_read_page\'s "Clickable elements" list (most reliable), or use browser_click_selector to click by CSS selector instead. The result tells you which element was actually hit.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Pixels from the left of the AI Browser window' },
            y: { type: 'number', description: 'Pixels from the top of the AI Browser window' }
          },
          required: ['x', 'y']
        }
      },
      {
        _computer: true,
        name: 'browser_click_selector',
        description: 'Click an element in the AI Browser by CSS selector (e.g. "button[type=submit]", "a[href*=login]"). The element is scrolled into view and clicked with your AI cursor — more reliable than raw coordinates.',
        input_schema: {
          type: 'object',
          properties: { selector: { type: 'string', description: 'CSS selector of the element to click' } },
          required: ['selector']
        }
      },
      {
        _computer: true,
        name: 'browser_type',
        description: 'Type text into the focused field in the AI Browser. Click the field first (browser_click or browser_click_selector), then type.',
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Text to type' } },
          required: ['text']
        }
      },
      {
        _computer: true,
        name: 'browser_key',
        description: 'Send a single key press to the AI Browser, e.g. "Enter", "Tab", "Backspace", "Escape".',
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string', description: 'Key name, e.g. Enter' } },
          required: ['key']
        }
      },
      {
        _computer: true,
        name: 'browser_scroll',
        description: 'Scroll the active AI Browser page up or down.',
        input_schema: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down'] },
            amount: { type: 'number', description: 'Notches to scroll (1-10, default 3)' }
          },
          required: []
        }
      },
      {
        _computer: true,
        name: 'browser_tabs',
        description: 'List the open AI Browser tabs. The active tab is where clicks and typing go.',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        _computer: true,
        name: 'browser_new_tab',
        description: 'Open a new tab in the AI Browser and make it the active tab.',
        input_schema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL to open in the new tab' } },
          required: ['url']
        }
      },
      {
        _computer: true,
        name: 'browser_close_tab',
        description: 'Close an AI Browser tab by its id (from browser_tabs).',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Tab id, e.g. tab1' } },
          required: ['id']
        }
      },
      {
        _computer: true,
        name: 'browser_back',
        description: 'Go back one page in the AI Browser.',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        _computer: true,
        name: 'browser_forward',
        description: 'Go forward one page in the AI Browser.',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        _computer: true,
        name: 'ai_mouse_move',
        description: 'Move your own visible AI mouse cursor to x,y in the AI Browser (without clicking). The user sees it move.',
        input_schema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Pixels from the left' },
            y: { type: 'number', description: 'Pixels from the top' }
          },
          required: ['x', 'y']
        }
      }
    ];
  }

  /* Run a tool; resolves to plain text for the model (errors included). */
  function call(name, args) {
    if (!bridge) return Promise.resolve('Computer use is only available in the desktop app.');
    return bridge.call(name, args || {}).then(function (r) {
      if (!r) return '(no result)';
      if (r.ok) return r.result || '(empty result)';
      return 'Error: ' + (r.error || 'the tool failed');
    }, function (e) {
      return 'Error: ' + ((e && e.message) || e);
    });
  }

  function setEnabled(on) {
    if (!bridge) return Promise.resolve({ enabled: false });
    return bridge.setEnabled(on).then(function (r) { state.enabled = !!(r && r.enabled); return r; });
  }

  function setApprovalMode(mode) {
    if (!bridge) return Promise.resolve({ approvalMode: 'manual' });
    return bridge.setApprovalMode(mode).then(function (r) {
      state.approvalMode = (r && r.approvalMode) || mode;
      return r;
    });
  }

  function setFullAccess(on) {
    if (!bridge) return Promise.resolve({ fullAccess: false });
    return bridge.setFullAccess(on).then(function (r) {
      if (r) state.fullAccess = !!r.fullAccess;
      return r;
    });
  }

  function addRoot() {
    if (!bridge) return Promise.resolve({ ok: false });
    return bridge.addRoot().then(function (r) {
      if (r && r.ok) state.roots = r.roots || [];
      return r;
    });
  }

  function removeRoot(root) {
    if (!bridge) return Promise.resolve({ ok: false });
    return bridge.removeRoot(root).then(function (r) {
      if (r && r.ok) state.roots = r.roots || [];
      return r;
    });
  }

  window.ToplixComputer = {
    available: function () { return !!bridge; },
    refresh: refresh,
    toolDefs: toolDefs,
    call: call,
    setEnabled: setEnabled,
    setApprovalMode: setApprovalMode,
    setFullAccess: setFullAccess,
    addRoot: addRoot,
    removeRoot: removeRoot,
    log: function () { return bridge ? bridge.log() : Promise.resolve([]); },
    isEnabled: function () { return state.enabled; },
    roots: function () { return state.roots.slice(); },
    approvalMode: function () { return state.approvalMode; },
    fullAccess: function () { return state.fullAccess; },
    isConfigured: function () { return state.enabled && (state.roots.length > 0 || state.fullAccess); }
  };
})();
