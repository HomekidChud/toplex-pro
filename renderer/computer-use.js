/* Toplix Pro — computer-use mode (desktop only).
 * The strict safety rules (approved folders only, credentials always blocked,
 * approval dialog for every write/command, blocked dangerous commands, audit
 * log) are enforced in the Electron main process. This file only exposes the
 * tools to the model and relays calls.
 */
(function () {
  'use strict';
  var bridge = window.toplexComputer || null;

  var state = { enabled: false, roots: [], platform: '' };

  function refresh() {
    if (!bridge) return Promise.resolve();
    return bridge.status().then(function (s) {
      state.enabled = !!s.enabled;
      state.roots = s.roots || [];
      state.platform = s.platform;
      return s;
    });
  }

  /* Tool definitions handed to the model in computer-use mode. */
  function toolDefs() {
    return [
      {
        _computer: true,
        name: 'computer_list_files',
        description: 'List the contents of a folder on the user\'s computer. Only works inside folders the user approved.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute folder path' } },
          required: ['path']
        }
      },
      {
        _computer: true,
        name: 'computer_read_file',
        description: 'Read a text file (up to 256 KB) from an approved folder.',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute file path' } },
          required: ['path']
        }
      },
      {
        _computer: true,
        name: 'computer_write_file',
        description: 'Write a file in an approved folder. The user sees an approval dialog with the target path before anything is written.',
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
        description: 'Run a shell command in an approved folder. Never elevated (sudo blocked), destructive commands blocked, killed after 60 seconds, and the user must approve it in a dialog first.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to run' },
            cwd: { type: 'string', description: 'Folder to run it in (must be an approved folder)' }
          },
          required: ['command', 'cwd']
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
    addRoot: addRoot,
    removeRoot: removeRoot,
    log: function () { return bridge ? bridge.log() : Promise.resolve([]); },
    isEnabled: function () { return state.enabled; },
    roots: function () { return state.roots.slice(); },
    isConfigured: function () { return state.enabled && state.roots.length > 0; }
  };
})();
