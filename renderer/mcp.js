/* Toplix Pro — mcp.js
 * Model Context Protocol client (streamable HTTP transport).
 * Connects to MCP servers, lists their tools, and calls them.
 * Used by the chat loop so models can use connected tools.
 */
(function (global) {
  'use strict';

  var rpcId = 0;

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* Read a JSON-RPC response that may come back as plain JSON or as SSE. */
  async function readRpcResponse(res) {
    var ctype = (res.headers.get('content-type') || '').toLowerCase();
    var text = await res.text();
    if (ctype.indexOf('text/event-stream') !== -1 || text.indexOf('data:') === 0) {
      var result = null;
      text.split('\n').forEach(function (line) {
        if (!line.startsWith('data:')) return;
        var payload = safeParse(line.slice(5).trim());
        if (payload && payload.result !== undefined) result = payload.result;
        if (payload && payload.error) result = { error: payload.error };
      });
      return result;
    }
    var parsed = safeParse(text);
    if (!parsed) throw new Error('Invalid MCP response');
    if (parsed.error) throw new Error(parsed.error.message || 'MCP error');
    return parsed.result;
  }

  async function rpc(server, method, params) {
    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (server.apiKey) headers['Authorization'] = 'Bearer ' + server.apiKey;
    Object.assign(headers, server.extraHeaders || {});

    var res = await fetch(server.url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: method,
        params: params || {}
      })
    });
    if (!res.ok) {
      var body = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + (body ? ' — ' + body.slice(0, 200) : ''));
    }
    return readRpcResponse(res);
  }

  /* Test a server: initialize + list tools. Returns {ok, tools, error}. */
  async function connect(server) {
    try {
      var init = await rpc(server, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Toplix Pro', version: '1.2.0' }
      });
      // optional notification — some servers require it before tools
      try {
        await rpc(server, 'notifications/initialized', {});
      } catch (e) { /* best effort */ }
      var toolsResult = await rpc(server, 'tools/list', {});
      return {
        ok: true,
        serverInfo: init && init.serverInfo,
        tools: (toolsResult && toolsResult.tools) || []
      };
    } catch (e) {
      return { ok: false, error: e.message, tools: [] };
    }
  }

  /* Call a tool. Returns {content, isError}. */
  async function callTool(server, name, args) {
    var result = await rpc(server, 'tools/call', { name: name, arguments: args || {} });
    return result;
  }

  /* Flatten all tools from all enabled servers into OpenAI/Anthropic tool defs. */
  function toolDefs(servers, toolsByServer) {
    var defs = [];
    servers.forEach(function (server) {
      (toolsByServer[server.id] || []).forEach(function (tool) {
        defs.push({
          _server: server.id,
          _tool: tool.name,
          name: 'toplx_' + server.id + '_' + tool.name,
          description: (tool.description || tool.name).slice(0, 800),
          input_schema: tool.inputSchema || { type: 'object', properties: {} }
        });
      });
    });
    return defs;
  }

  /* Convert content blocks to plain text for the model. */
  function resultToText(result) {
    if (!result) return '(empty result)';
    if (typeof result === 'string') return result;
    return (result.content || []).map(function (block) {
      if (typeof block === 'string') return block;
      if (block.type === 'text') return block.text;
      return JSON.stringify(block);
    }).join('\n') || JSON.stringify(result).slice(0, 2000);
  }

  global.ToplixMCP = {
    connect: connect,
    callTool: callTool,
    toolDefs: toolDefs,
    resultToText: resultToText
  };
})(typeof window !== 'undefined' ? window : globalThis);
