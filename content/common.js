// No More Scissors — helpers shared by every content script. Loaded first (see manifest.json).
// Frozen contract: see docs/architecture.md. Add feature-specific helpers in your own file.
(() => {
  'use strict';
  if (window.NMS) return;

  const DEFAULTS = {
    enabled: true, cutoff: 40, hideCutoff: 85, showScores: true, blurPending: true,
    rewriteStyle: 'neutral', provider: 'openai',
  };
  const KEY_KEYS = ['provider', 'apiKey', 'anthropicKey', 'compatibleKey', 'baseUrl'];

  const NMS = { settings: { ...DEFAULTS }, alive: true };
  const listeners = [];

  NMS.bg = async function bg(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (/context invalidated|Receiving end does not exist/i.test(String(err))) NMS.alive = false;
      return { ok: false, error: err.message };
    }
  };

  NMS.onSettings = (cb) => listeners.push(cb);

  NMS.ready = chrome.storage.local.get(Object.keys(DEFAULTS)).then((stored) => {
    for (const k of Object.keys(DEFAULTS)) if (stored[k] !== undefined) NMS.settings[k] = stored[k];
    return NMS.settings;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changed = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (k in changes) { NMS.settings[k] = changes[k].newValue ?? DEFAULTS[k]; changed[k] = NMS.settings[k]; }
    }
    for (const k of KEY_KEYS) if (k in changes) changed.credentials = true;
    if (Object.keys(changed).length) for (const cb of listeners) { try { cb(changed); } catch (e) { console.error('[nms]', e); } }
  });

  // X wraps mentions and links in inline-flex <div>s, renders emoji as <img alt>, and ends long
  // posts with a "Show more" link; decide block vs inline with computed style, not tag names.
  NMS.extractText = function extractText(root) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'IMG') { out += node.getAttribute('alt') || ''; return; }
      if (tag === 'BR') { out += '\n'; return; }
      if (tag === 'A' && (node.dataset.testid === 'tweet-text-show-more-link' || /^show more$/i.test(node.textContent.trim()))) return;
      if (node.classList && (node.classList.contains('nms-rewrite') || node.classList.contains('nms-ui'))) return;
      const block = (tag === 'DIV' || tag === 'P') && !getComputedStyle(node).display.startsWith('inline');
      if (block && out && !out.endsWith('\n')) out += '\n';
      for (const child of node.childNodes) walk(child);
      if (block && out && !out.endsWith('\n')) out += '\n';
    };
    walk(root);
    return out.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  };

  NMS.scoreColor = (score) => {
    const hue = Math.max(0, Math.min(120, 120 - score * 1.2));
    return `hsl(${hue.toFixed(0)} 72% 44%)`;
  };

  NMS.scoreLabel = (score) => {
    if (score >= 80) return 'abusive';
    if (score >= 60) return 'aggressive';
    if (score >= 40) return 'hostile';
    if (score >= 20) return 'snarky';
    return 'calm';
  };

  NMS.el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // A dot + number, coloured by score. Inherits font and colour from where you put it.
  // opts.separator adds X's "·" before it (for header rows); opts.reason sets the tooltip.
  NMS.badge = (score, reason, opts = {}) => {
    const b = NMS.el('span', 'nms-badge nms-ui');
    if (opts.separator) b.appendChild(NMS.el('span', 'nms-sep', '·'));
    const dot = NMS.el('span', 'nms-dot');
    dot.style.background = NMS.scoreColor(score);
    b.appendChild(dot);
    b.appendChild(NMS.el('span', 'nms-num', String(score)));
    b.title = `Inflammatory wording: ${score}/100 (${NMS.scoreLabel(score)})${reason ? ` — ${reason}` : ''}`;
    return b;
  };

  NMS.copyTextStyle = (from, to, props = ['font-family', 'font-size', 'line-height', 'font-weight', 'color', 'letter-spacing']) => {
    const cs = getComputedStyle(from);
    for (const p of props) to.style.setProperty(p, cs.getPropertyValue(p));
  };

  NMS.postId = (scope) => {
    const a = scope.querySelector('a[href*="/status/"]');
    const m = a && a.getAttribute('href').match(/\/status\/(\d+)/);
    return m ? m[1] : '';
  };

  NMS.authorOf = (scope) => {
    const header = scope.querySelector('[data-testid="User-Name"]') || scope;
    for (const a of header.querySelectorAll('a[href^="/"]')) {
      const m = a.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
      if (m && !/^(home|explore|notifications|messages|search|settings|compose|i|jobs|hashtag)$/i.test(m[1])) return m[1];
    }
    return '';
  };

  NMS.isProfilePath = (pathname) => {
    const m = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|highlights|media|likes|articles))?\/?$/);
    return !!m && !/^(home|explore|notifications|messages|search|settings|compose|i|jobs|login|signup|tos|privacy)$/i.test(m[1]);
  };

  NMS.debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  window.NMS = NMS;
})();
