// Test harness only (not shipped). A fake chrome.* so the content scripts can be pasted into a
// logged-in x.com console without installing the extension. Implements the message protocol in
// docs/architecture.md with deterministic results: score = hash(text) % 100, posts >= hideCutoff
// are hidden, flagged posts get a visible "Calmer take:" rewrite. Never posts or likes anything.
(() => {
  const mem = {
    enabled: true, cutoff: 40, hideCutoff: 85, showScores: true, blurPending: true,
    rewriteStyle: 'neutral', provider: 'openai', apiKey: 'sk-fake', anthropicKey: '', compatibleKey: '', baseUrl: '',
    scoreModel: 'gpt-5.4-nano', rewriteModel: 'gpt-5.4-mini', customStyle: '', spendCap: 10, onboarded: true,
  };
  const listeners = [];
  const local = {
    async get(keys) {
      if (keys === null) return { ...mem };
      const out = {};
      const arr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of arr) if (k in mem) out[k] = mem[k];
      return out;
    },
    async set(obj) { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: mem[k], newValue: v }; mem[k] = v; } listeners.forEach((l) => l(ch, 'local')); },
    async remove(keys) { for (const k of [].concat(keys)) delete mem[k]; },
  };
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return Math.abs(h); };
  const reasons = ['calm explanation', 'light mockery', 'sneering at a group', 'insulting a person', 'dehumanizing language'];
  const calls = [];
  const authors = {};
  const latency = () => new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
  const scoreOf = (text) => { const s = hash(text) % 100; return { score: s, reason: reasons[Math.min(4, Math.floor(s / 20))] }; };

  async function sendMessage(msg) {
    calls.push(msg);
    if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'bad message' };
    switch (msg.type) {
      case 'analyze': {
        await latency();
        if (!mem.enabled) return { ok: false, error: 'disabled' };
        const results = (msg.items || []).map((it) => {
          const { score, reason } = scoreOf(it.text || '');
          const flagged = score >= mem.cutoff;
          const hidden = score >= mem.hideCutoff;
          const rewrite = flagged && (!hidden || it.force) ? 'Calmer take: ' + it.text.replace(/!+/g, '.') : null;
          if (it.author && it.id) {
            const a = authors[it.author] || (authors[it.author] = { ids: [], scores: [] });
            if (!a.ids.includes(it.id)) { a.ids.push(it.id); a.scores.push(score); if (a.ids.length > 30) { a.ids.shift(); a.scores.shift(); } }
          }
          return { ok: true, score, reason, flagged, hidden, rewrite };
        });
        return { ok: true, results };
      }
      case 'score': { await latency(); return { ok: true, ...scoreOf(msg.text || '') }; }
      case 'authorHeat': {
        const a = authors[msg.handle];
        if (!a || !a.scores.length) return { ok: true, avg: null, n: 0, scores: [] };
        return { ok: true, avg: Math.round(a.scores.reduce((x, y) => x + y, 0) / a.scores.length), n: a.scores.length, scores: a.scores };
      }
      case 'pageCounts': return { ok: true };
      case 'testKey': return { ok: true };
      case 'getStats': return { ok: true, stats: { scored: 0, rewritten: 0, usage: {}, month: '2026-09', monthUsage: {}, lastError: null, lastErrorAt: 0 }, cacheSize: 0, costTotal: 0, costMonth: 0, costEstimated: false, capReached: false, month: '2026-09' };
      default: return { ok: true };
    }
  }
  globalThis.chrome = {
    storage: { local, onChanged: { addListener: (l) => listeners.push(l) } },
    runtime: { sendMessage, getManifest: () => ({ update_url: 'store' }), onMessage: { addListener() {} }, getURL: (p) => p },
  };
  globalThis.__nmsTest = {
    mem, calls, authors,
    set: (obj) => local.set(obj),
    // Claude-in-Chrome tabs report document.hidden === true between tool calls; the core skips hidden tabs.
    visible: () => Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }),
  };
})();
