/* Toplix Pro — markdown.js
 * A small, dependency-free markdown renderer.
 * Escapes all HTML first, then applies a safe subset of markdown:
 * fenced code blocks, inline code, bold, italic, links, headings, lists.
 */
(function (global) {
  'use strict';

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&' + 'amp;')
      .replace(/</g, '&' + 'lt;')
      .replace(/>/g, '&' + 'gt;')
      .replace(/"/g, '&' + 'quot;')
      .replace(/'/g, '&' + '#39;');
  }

  /* Very lightweight syntax tokens — enough to make code readable. */
  var KEYWORDS = {
    js: /\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|extends|new|await|async|try|catch|throw|typeof|switch|case|break|continue|=>|null|undefined|true|false)\b/g,
    ts: /\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|extends|implements|interface|type|new|await|async|try|catch|throw|typeof|as|switch|case|break|continue|=>|null|undefined|true|false|string|number|boolean|void)\b/g,
    py: /\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|None|True|False|and|or|not|in|is|async|await)\b/g,
    go: /\b(func|package|import|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|switch|case|break|continue|nil|true|false|string|int|error)\b/g,
    rs: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|loop|for|while|return|self|Some|None|Ok|Err|async|await)\b/g,
    css: null,
    sh: /\b(if|then|fi|for|do|done|while|case|esac|export|echo|cd|sudo|npm|npx|git|curl|pip|python|python3|node|cargo|brew)\b/g
  };

  function aliasLang(lang) {
    var l = (lang || '').toLowerCase();
    if (l === 'javascript' || l === 'jsx') return 'js';
    if (l === 'typescript' || l === 'tsx') return 'ts';
    if (l === 'python') return 'py';
    if (l === 'golang') return 'go';
    if (l === 'rust') return 'rs';
    if (l === 'bash' || l === 'zsh' || l === 'shell') return 'sh';
    return l;
  }

  function highlightCode(code, lang) {
    var key = aliasLang(lang);
    var kwSource = KEYWORDS[key];
    var esc = escapeHtml;
    if (!kwSource) return esc(code);
    var kwRe = new RegExp(kwSource.source);
    // single pass: strings | comments | identifier-ish words
    var re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/\/[^\n]*|#[^\n]*)|([A-Za-z_$][\w$]*)/g;
    var out = '', last = 0, m;
    while ((m = re.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      if (m[1] !== undefined) {
        out += '<span class="tok-s">' + esc(m[1]) + '</span>';
      } else if (m[2] !== undefined) {
        out += '<span class="tok-c">' + esc(m[2]) + '</span>';
      } else if (kwRe.test(m[3])) {
        out += '<span class="tok-k">' + esc(m[3]) + '</span>';
      } else {
        out += esc(m[3]);
      }
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  function renderInline(text) {
    var out = escapeHtml(text);
    // inline code
    out = out.replace(/`([^`\n]+)`/g, function (m, code) {
      return '<code class="inline-code">' + code + '</code>';
    });
    // bold / italic
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // links [text](url)
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, function (m, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    return out;
  }

  function renderMarkdown(md) {
    if (typeof md !== 'string') return '';
    var lines = md.replace(/\r\n?/g, '\n').split('\n');
    var html = '';
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // fenced code block
      var fence = line.match(/^```([A-Za-z0-9+#._-]*)\s*$/);
      if (fence) {
        var lang = fence[1] || '';
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        var code = buf.join('\n');
        html += '<div class="code-block"><div class="code-block-head"><span>' +
          escapeHtml(lang || 'code') +
          '</span><button class="copy-code" type="button">Copy</button></div><pre><code>' +
          highlightCode(code, lang) + '</code></pre></div>';
        continue;
      }

      // headings
      var h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        var level = h[1].length;
        html += '<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>';
        i++;
        continue;
      }

      // lists (simple: consecutive - or * or 1. items)
      var listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        var ordered = /^\d+\./.test(listMatch[2]);
        var tag = ordered ? 'ol' : 'ul';
        html += '<' + tag + '>';
        while (i < lines.length) {
          var m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
          if (!m) break;
          html += '<li>' + renderInline(m[3]) + '</li>';
          i++;
        }
        html += '</' + tag + '>';
        continue;
      }

      // blank line
      if (!line.trim()) { i++; continue; }

      // paragraph — merge consecutive non-special lines
      var para = [];
      while (i < lines.length) {
        var l = lines[i];
        if (!l.trim()) break;
        if (/^```/.test(l) || /^#{1,3}\s/.test(l) || /^(\s*)([-*]|\d+\.)\s+/.test(l)) break;
        para.push(l);
        i++;
      }
      html += '<p>' + renderInline(para.join(' ')) + '</p>';
    }

    return html;
  }

  global.ToplixMarkdown = { render: renderMarkdown, escapeHtml: escapeHtml };
})(typeof window !== 'undefined' ? window : globalThis);
