// No More Scissors — page-world hook (manifest: world "MAIN", document_start).
//
// X sends only the first ~280 characters of a long post to the timeline DOM, but its own GraphQL
// responses carry the full text under `note_tweet`. This wraps fetch and XMLHttpRequest, walks
// every GraphQL response the page receives, and hands { post id → full text } to the content
// script through postMessage. Requests are never modified; responses are cloned, not consumed.
// Browsers that ignore `world` run this in the isolated world, where it wraps nothing and stays silent.
(() => {
  'use strict';
  if (window.__nmsHooked) return;
  window.__nmsHooked = true;

  const isGraphql = (url) => typeof url === 'string' && url.includes('/i/api/graphql/');

  function collect(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) { for (const v of node) collect(v, out, depth + 1); return; }
    const id = node.rest_id;
    const note = node.note_tweet && node.note_tweet.note_tweet_results && node.note_tweet.note_tweet_results.result;
    if (typeof id === 'string' && /^\d{5,25}$/.test(id) && note && typeof note.text === 'string') out[id] = note.text;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collect(v, out, depth + 1);
    }
  }

  function report(json) {
    const notes = {};
    collect(json, notes, 0);
    if (Object.keys(notes).length) window.postMessage({ type: 'nms-notes', notes }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isGraphql(url)) p.then((res) => { try { res.clone().json().then(report, () => {}); } catch (_) {} }, () => {});
    } catch (_) {}
    return p;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__nmsUrl = String(url); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (isGraphql(this.__nmsUrl)) {
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === '' || this.responseType === 'text' ? JSON.parse(this.responseText) : this.response;
          if (body && typeof body === 'object') report(body);
        } catch (_) {}
      });
    }
    return send.apply(this, arguments);
  };
})();
