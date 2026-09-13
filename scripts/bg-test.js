// Exercises background.js in node with a fake chrome.* and fake fetch. Run: node scripts/bg-test.js
'use strict';
const path = require('path');
const assert = require('assert');

let assertions = 0;
const A = new Proxy(assert, {
  get(t, k) { const v = t[k]; return typeof v === 'function' ? (...a) => { assertions++; return v.apply(t, a); } : v; },
});

// ---- fake Date so the month can be rolled over ----
const RealDate = Date;
let fakeNow = null;
class FakeDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(fakeNow ?? RealDate.now()); }
  static now() { return fakeNow ?? RealDate.now(); }
}
globalThis.Date = FakeDate;

// ---- fake chrome ----
const store = {};
const changeListeners = [];
const sync = { apiKey: 'sk-old-v1-key', inflammatoryCutoff: 0.2 };
let onMessage = null, onInstalled = null;
const badge = [];       // every chrome.action call: { method, ...args }
const tabsCreated = []; // chrome.tabs.create args
const grantedOrigins = ['https://api.openai.com/*', 'https://api.anthropic.com/*'];
const COMPAT = 'http://localhost:11434/v1';

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return { ...store };
        const arr = typeof keys === 'string' ? [keys] : keys;
        const out = {}; for (const k of arr) if (k in store) out[k] = store[k]; return out;
      },
      async set(obj) {
        const ch = {};
        for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
        changeListeners.forEach((l) => l(ch, 'local'));
      },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    },
    sync: { async get() { return { ...sync }; }, async remove(keys) { for (const k of keys) delete sync[k]; } },
    onChanged: { addListener: (l) => changeListeners.push(l) },
  },
  runtime: {
    onMessage: { addListener: (l) => { onMessage = l; } },
    onInstalled: { addListener: (l) => { onInstalled = l; } },
    onStartup: { addListener() {} },
    getManifest: () => ({}),
    getURL: (p) => 'chrome-extension://nms/' + p,
    reload() {},
  },
  action: {
    setBadgeText: async (a) => { badge.push({ method: 'setBadgeText', ...a }); },
    setBadgeBackgroundColor: async (a) => { badge.push({ method: 'setBadgeBackgroundColor', ...a }); },
    setTitle: async (a) => { badge.push({ method: 'setTitle', ...a }); },
  },
  tabs: { create: async (a) => { tabsCreated.push(a); return { id: 99 }; }, onRemoved: { addListener() {} } },
  permissions: { contains: async ({ origins }) => origins.every((o) => grantedOrigins.includes(o)) },
};

// ---- fake providers ----
const calls = [];
let concurrent = 0, maxConcurrent = 0;
const script = []; // queue of response overrides: fn(body, call) -> {status, json, headers} | undefined (consumed either way)
let delay = 0;
let compatModels = 200; // status of GET {COMPAT}/models, or 'down'

function jsonRes(status, obj, headers = {}) {
  return { ok: status < 300, status, statusText: 'x', headers: { get: (h) => headers[h.toLowerCase()] }, json: async () => obj };
}
function lowerHeaders(h) { const out = {}; for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v; return out; }
function fakeScore(t) { return /vermin/i.test(t) ? 90 : /moron|idiot/i.test(t) ? 66 : /lol/i.test(t) ? 28 : 5; }
function postsOf(user) {
  const parts = user.split(/^### Post (\d+)\n/m);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1].trim().replace(/^Language: \S+\n/, '').trim();
    out.push({ index: Number(parts[i]), text: body });
  }
  return out;
}
const scoreJson = (user) => JSON.stringify({ results: postsOf(user).map((p) => ({ index: p.index, score: fakeScore(p.text), reason: 'fake reason' })) });
const rewriteJson = (user) => JSON.stringify({ rewrite: 'CALM: ' + user.split('\n').pop() });
const isScoreSystem = (s) => /^You rate/.test(s);

globalThis.fetch = async (url, opts = {}) => {
  const headers = lowerHeaders(opts.headers);
  const body = opts.body ? JSON.parse(opts.body) : null;
  const call = { url, body, headers, auth: headers.authorization };
  calls.push(call);
  concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  concurrent--;
  const override = script.length ? script.shift()(body, call) : undefined;
  if (override) return jsonRes(override.status, override.json, override.headers);
  if (url === 'https://api.openai.com/v1/models') return jsonRes(/bad/.test(headers.authorization || '') ? 401 : 200, {});
  if (url === 'https://api.anthropic.com/v1/models') return jsonRes(/bad/.test(headers['x-api-key'] || '') ? 401 : 200, {});
  if (url === COMPAT + '/models') { if (compatModels === 'down') throw new TypeError('Failed to fetch'); return jsonRes(compatModels, {}); }
  if (url === 'https://api.anthropic.com/v1/messages') {
    const text = isScoreSystem(body.system[0].text) ? scoreJson(body.messages[0].content) : rewriteJson(body.messages[0].content);
    return jsonRes(200, { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } });
  }
  // chat completions (OpenAI and compatible)
  let content = isScoreSystem(body.messages[0].content) ? scoreJson(body.messages[1].content) : rewriteJson(body.messages[1].content);
  if (!body.response_format) content = 'Sure! Here you go:\n```json\n' + content + '\n```'; // no JSON mode → prose + fences
  return jsonRes(200, { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
};

require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'background.js')));
const send = (msg, sender = {}) => new Promise((resolve) => { onMessage(msg, sender, resolve); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const badgeHas = (method, props) => badge.some((b) => b.method === method && Object.entries(props).every(([k, v]) => b[k] === v));
const schemaName = (c) => c.body && c.body.response_format && c.body.response_format.json_schema && c.body.response_format.json_schema.name;

(async () => {
  await sleep(20);

  // ---- v1 migration moved the key from sync to local ----
  A.strictEqual(store.apiKey, 'sk-old-v1-key', 'migrated key');
  A.strictEqual(sync.apiKey, undefined, 'sync key removed');

  // ---- no key → no-key + "!" badge ----
  await chrome.storage.local.set({ apiKey: '' }); await sleep(5);
  let r = await send({ type: 'analyze', items: [{ id: '', text: 'These people are morons', lang: 'en', author: '', force: false }] });
  A.deepStrictEqual(r, { ok: false, error: 'no-key' });
  A.strictEqual(calls.length, 0);
  A.ok(badgeHas('setBadgeText', { text: '!', tabId: undefined }), 'global ! badge');
  A.ok(badgeHas('setBadgeBackgroundColor', { color: '#d64545', tabId: undefined }));
  badge.length = 0;
  await chrome.storage.local.set({ apiKey: 'sk-test' }); await sleep(5);
  A.ok(badgeHas('setBadgeText', { text: '', tabId: undefined }), 'badge cleared once a key exists');
  r = await send({ type: 'analyze', text: 'legacy shape' }); A.strictEqual(r.ok, false);

  // ---- batch of 10 new posts: exactly 2 scoring calls (8 + 2), results mapped by index ----
  const texts = []; for (let i = 0; i < 10; i++) texts.push(`Calm post number ${i}`);
  texts[2] = 'These people are morons';     // 66 → flagged
  texts[5] = 'lol nice one';                // 28
  texts[7] = 'Every one of them is vermin'; // 90 → hidden
  texts[9] = 'Such idiots, all of them';    // 66 → flagged
  const items = texts.map((text, i) => ({ id: 'p' + i, text, lang: i % 2 ? 'en' : '', author: 'alice', force: false }));
  r = await send({ type: 'analyze', items });
  A.strictEqual(r.ok, true); A.strictEqual(r.results.length, 10);
  const scoreCalls = calls.filter((c) => schemaName(c) === 'inflammatory_scores');
  const rwCalls = calls.filter((c) => schemaName(c) === 'calm_rewrite');
  A.strictEqual(scoreCalls.length, 2, '8 + 2 scoring calls');
  A.strictEqual(postsOf(scoreCalls[0].body.messages[1].content).length, 8);
  A.strictEqual(postsOf(scoreCalls[1].body.messages[1].content).length, 2);
  const sc = scoreCalls[0].body;
  A.strictEqual(scoreCalls[0].url, 'https://api.openai.com/v1/chat/completions');
  A.strictEqual(sc.model, 'gpt-5.4-nano');
  A.strictEqual(sc.response_format.type, 'json_schema');
  A.strictEqual(sc.response_format.json_schema.strict, true);
  A.strictEqual(sc.response_format.json_schema.name, 'inflammatory_scores');
  A.deepStrictEqual(sc.response_format.json_schema.schema.required, ['results']);
  A.deepStrictEqual(sc.response_format.json_schema.schema.properties.results.items.required, ['index', 'score', 'reason']);
  A.ok(sc.messages[1].content.includes('### Post 1\n')); A.ok(sc.messages[1].content.includes('### Post 8\n'));
  A.ok(sc.messages[1].content.includes('Language: en'));
  A.strictEqual(sc.messages[0].role, 'system');
  A.strictEqual(sc.reasoning_effort, 'none');
  A.ok(sc.max_completion_tokens > 0 && !('max_tokens' in sc) && !('temperature' in sc));
  A.strictEqual(scoreCalls[0].auth, 'Bearer sk-test');
  A.ok(sc.messages[0].content.length >= 4000, 'system prompt padded for prompt caching');
  A.strictEqual(sc.messages[0].content, scoreCalls[1].body.messages[0].content, 'byte-identical system prompt');
  r.results.forEach((res, i) => { A.strictEqual(res.ok, true); A.strictEqual(res.score, fakeScore(texts[i]), 'score of item ' + i); A.strictEqual(res.reason, 'fake reason'); });
  A.strictEqual(r.results[2].flagged, true); A.strictEqual(r.results[2].hidden, false);
  A.strictEqual(r.results[2].rewrite, 'CALM: These people are morons');
  A.strictEqual(r.results[9].rewrite, 'CALM: Such idiots, all of them');
  A.strictEqual(r.results[7].flagged, true); A.strictEqual(r.results[7].hidden, true); A.strictEqual(r.results[7].rewrite, null, 'hidden → no rewrite');
  A.strictEqual(r.results[0].flagged, false); A.strictEqual(r.results[0].hidden, false); A.strictEqual(r.results[0].rewrite, null);
  A.strictEqual(r.results[5].score, 28); A.strictEqual(r.results[5].flagged, false);
  A.strictEqual(rwCalls.length, 2, 'rewrite calls only for flagged, non-hidden posts');
  A.strictEqual(rwCalls[0].body.model, 'gpt-5.4-mini');
  A.ok(rwCalls[0].body.messages[1].content.includes('rated 66/100'));
  A.ok(rwCalls[0].body.messages[1].content.includes('language: en') || rwCalls[1].body.messages[1].content.includes('language: en'));
  A.ok(rwCalls[0].body.messages[0].content.startsWith('You rewrite'));
  A.ok(!/Style:|Additional instruction/.test(rwCalls[0].body.messages[0].content), 'neutral adds nothing');
  A.strictEqual(calls.length, 4);

  // ---- cache hits make no calls ----
  r = await send({ type: 'analyze', items });
  A.strictEqual(calls.length, 4); A.strictEqual(r.results[2].rewrite, 'CALM: These people are morons'); A.strictEqual(r.results[7].rewrite, null);

  // ---- force:true on a hidden post → one rewrite call, then cached ----
  r = await send({ type: 'analyze', items: [{ ...items[7], force: true }] });
  A.strictEqual(calls.length, 5); A.strictEqual(schemaName(calls[4]), 'calm_rewrite');
  A.strictEqual(r.results[0].hidden, true); A.strictEqual(r.results[0].rewrite, 'CALM: Every one of them is vermin');
  r = await send({ type: 'analyze', items: [{ ...items[7], force: true }] }); A.strictEqual(calls.length, 5);
  await chrome.storage.local.set({ hideCutoff: 101 }); // never hide
  r = await send({ type: 'analyze', items: [items[7]] });
  A.strictEqual(r.results[0].hidden, false); A.strictEqual(r.results[0].rewrite, 'CALM: Every one of them is vermin'); A.strictEqual(calls.length, 5);
  await chrome.storage.local.set({ hideCutoff: 85 });

  // ---- lowering cutoff on a cached score → exactly one rewrite call ----
  await chrome.storage.local.set({ cutoff: 3 });
  r = await send({ type: 'analyze', items: [items[0]] });
  A.strictEqual(r.results[0].flagged, true); A.strictEqual(calls.length, 6); A.strictEqual(schemaName(calls[5]), 'calm_rewrite');
  A.strictEqual(r.results[0].rewrite, 'CALM: Calm post number 0');
  await chrome.storage.local.set({ cutoff: 40 });

  // ---- rewriteStyle changes regenerate once and cache under the style key ----
  await chrome.storage.local.set({ rewriteStyle: 'kind' });
  r = await send({ type: 'analyze', items: [items[2]] });
  A.strictEqual(calls.length, 7); A.match(calls[6].body.messages[0].content, /good faith/);
  r = await send({ type: 'analyze', items: [items[2]] }); A.strictEqual(calls.length, 7, 'kind rewrite cached');
  const h2 = Object.keys(store).find((k) => k.startsWith('c:') && store[k].w === 'CALM: These people are morons');
  A.strictEqual(store[h2].wk, 'kind'); A.strictEqual(store[h2].s, 66);
  await chrome.storage.local.set({ rewriteStyle: 'light' });
  r = await send({ type: 'analyze', items: [items[2]] }); A.strictEqual(calls.length, 8); A.match(calls[7].body.messages[0].content, /as few words as possible/);
  await chrome.storage.local.set({ rewriteStyle: 'custom', customStyle: 'Make it sound like a pirate.' });
  r = await send({ type: 'analyze', items: [items[2]] }); A.strictEqual(calls.length, 9);
  A.ok(calls[8].body.messages[0].content.endsWith('Additional instruction from the user:\nMake it sound like a pirate.'));
  A.ok(store[h2].wk.startsWith('custom:'));
  r = await send({ type: 'analyze', items: [items[2]] }); A.strictEqual(calls.length, 9, 'custom rewrite cached');
  await chrome.storage.local.set({ rewriteStyle: 'neutral', customStyle: '' });
  r = await send({ type: 'analyze', items: [items[2]] }); A.strictEqual(calls.length, 10, 'back to neutral regenerates once');
  A.strictEqual(store[h2].wk, 'neutral');

  // ---- persistence + stats ----
  A.strictEqual(Object.keys(store).filter((k) => k.startsWith('c:')).length, 10);
  await sleep(500);
  A.strictEqual(store.stats.scored, 10); A.strictEqual(store.stats.rewritten, 8);
  A.strictEqual(store.stats.usage['gpt-5.4-nano'].in, 200); A.strictEqual(store.stats.usage['gpt-5.4-nano'].calls, 2);
  A.strictEqual(store.stats.monthUsage['gpt-5.4-mini'].calls, 8); A.strictEqual(store.stats.monthUsage['gpt-5.4-mini'].out, 160);
  A.match(store.stats.month, /^\d{4}-\d{2}$/);

  // ---- author history + authorHeat ----
  A.deepStrictEqual([...store['a:alice'].ids].sort(), texts.map((_, i) => 'p' + i).sort());
  r = await send({ type: 'authorHeat', handle: 'alice' });
  A.strictEqual(r.ok, true); A.strictEqual(r.n, 10);
  A.strictEqual(r.avg, Math.round(texts.map(fakeScore).reduce((a, b) => a + b, 0) / 10));
  r = await send({ type: 'authorHeat', handle: '@Alice' }); A.strictEqual(r.n, 10, 'handle normalised');
  r = await send({ type: 'authorHeat', handle: 'nobody' }); A.deepStrictEqual(r, { ok: true, avg: null, n: 0, scores: [] });
  const many = [];
  for (let i = 0; i < 35; i++) many.push({ id: 'b' + i, text: i % 5 === 0 ? `bob is a moron ${i}` : `bob calm ${i}`, lang: '', author: 'bob', force: false });
  r = await send({ type: 'analyze', items: many }); A.strictEqual(r.ok, true); r.results.forEach((x) => A.strictEqual(x.ok, true));
  A.strictEqual(store['a:bob'].ids.length, 30, 'last 30 distinct ids');
  A.strictEqual(store['a:bob'].ids[0], 'b5'); A.strictEqual(store['a:bob'].ids[29], 'b34');
  A.strictEqual(new Set(store['a:bob'].ids).size, 30);
  r = await send({ type: 'analyze', items: [many[34], many[34]] });
  A.strictEqual(store['a:bob'].ids.length, 30); A.strictEqual(store['a:bob'].ids[29], 'b34'); A.strictEqual(new Set(store['a:bob'].ids).size, 30, 'deduped by id');
  r = await send({ type: 'authorHeat', handle: 'bob' });
  const expected = many.slice(5).map((m) => fakeScore(m.text));
  A.strictEqual(r.n, 30); A.deepStrictEqual(r.scores, expected); A.strictEqual(r.avg, Math.round(expected.reduce((a, b) => a + b, 0) / 30));
  await send({ type: 'analyze', items: [{ id: '', text: 'anon post', lang: '', author: 'carol', force: false }, { id: 'z1', text: 'anon post two', lang: '', author: '', force: false }] });
  A.strictEqual(store['a:carol'], undefined, 'no id → not recorded');

  // ---- score (composer): same cache, never rewrites, never records ----
  let b = calls.length;
  r = await send({ type: 'score', text: 'You absolute moron' });
  A.deepStrictEqual(r, { ok: true, score: 66, reason: 'fake reason' });
  A.strictEqual(calls.length, b + 1); A.strictEqual(schemaName(calls[b]), 'inflammatory_scores');
  A.ok(calls[b].body.messages[1].content.includes('### Post 1'));
  r = await send({ type: 'score', text: 'You absolute moron' }); A.strictEqual(calls.length, b + 1, 'score cache hit');
  r = await send({ type: 'score', text: '   ' }); A.strictEqual(r.ok, false);
  r = await send({ type: 'analyze', items: [{ id: 'q', text: 'You absolute moron', lang: '', author: 'dave', force: false }] });
  A.strictEqual(calls.length, b + 2); A.strictEqual(schemaName(calls[b + 1]), 'calm_rewrite'); A.strictEqual(r.results[0].rewrite, 'CALM: You absolute moron');

  // ---- retries and fatal errors (openai) ----
  script.push(() => ({ status: 429, json: { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '0.01' } }));
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Another calm post about tea' }] });
  A.strictEqual(r.results[0].ok, true); A.strictEqual(calls.length, b + 2, '429 retried');
  script.push(() => ({ status: 429, json: { error: { message: 'quota', code: 'insufficient_quota' } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Post number four' }] });
  A.strictEqual(r.ok, true); A.strictEqual(r.results[0].ok, false); A.match(r.results[0].error, /credits/); A.strictEqual(calls.length, b + 3, 'no retry on quota');
  await sleep(500); A.match(store.stats.lastError, /credits/);
  // Out of credits: no API calls for a minute, top-level error, "!" badge; a key change lifts it.
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Post while out of credits' }] });
  A.strictEqual(r.ok, false); A.match(r.error, /credits/); A.strictEqual(calls.length, b, 'blocked: no fetch while out of credits');
  A.ok(badgeHas('setBadgeText', { text: '!', tabId: undefined }), 'no-credits badge');
  await chrome.storage.local.set({ apiKey: 'sk-test-a' }); await sleep(5);
  script.push(() => ({ status: 429, json: { error: { message: 'You have no credits remaining. Add credits to continue.', code: 'rate_limit_exceeded' } } }));
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Credits message without the quota code' }] });
  A.strictEqual(calls.length, b + 1, 'no retry on a no-credits 429 without the quota code'); A.match(r.results[0].error, /credits/);
  await chrome.storage.local.set({ apiKey: 'sk-test-b' }); await sleep(5);
  script.push(() => ({ status: 500, json: {}, headers: { 'retry-after': '0.01' } })); script.push(() => ({ status: 503, json: {}, headers: { 'retry-after': '0.01' } }));
  b = calls.length; r = await send({ type: 'analyze', items: [{ text: 'Flaky server post' }] });
  A.strictEqual(r.results[0].ok, true); A.strictEqual(calls.length, b + 3, 'two 5xx then success');
  for (let i = 0; i < 3; i++) script.push(() => ({ status: 500, json: {}, headers: { 'retry-after': '0.01' } }));
  b = calls.length; r = await send({ type: 'analyze', items: [{ text: 'Dead server post' }] });
  A.strictEqual(r.results[0].ok, false); A.strictEqual(calls.length, b + 3, 'gives up after 3 attempts');
  script.push(() => ({ status: 404, json: { error: { message: 'nope', code: 'model_not_found' } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Model not found post' }] }); A.match(r.results[0].error, /not found/);
  badge.length = 0;
  script.push(() => ({ status: 401, json: { error: { message: 'bad key' } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Post number five' }] });
  A.strictEqual(r.ok, true); A.match(r.results[0].error, /Invalid OpenAI API key/);
  A.ok(badgeHas('setBadgeText', { text: '!', tabId: undefined }), 'invalid-key badge');
  badge.length = 0;
  await chrome.storage.local.set({ apiKey: 'sk-test2' }); await sleep(5);
  A.ok(badgeHas('setBadgeText', { text: '', tabId: undefined }), 'badge cleared after the key changes');
  await chrome.storage.local.set({ scoreModel: 'gpt-5-mini' });
  script.push((body) => body.reasoning_effort ? ({ status: 400, json: { error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal'" } } }) : undefined);
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Post number six lol' }] });
  A.strictEqual(r.results[0].score, 28); A.strictEqual(calls.length, b + 2);
  A.strictEqual(calls[b].body.reasoning_effort, 'minimal'); A.strictEqual(calls[b + 1].body.reasoning_effort, undefined);
  await chrome.storage.local.set({ scoreModel: 'gpt-5.4-nano' });

  // ---- a post missing from the reply → per-item error ----
  script.push(() => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ results: [{ index: 2, score: 7, reason: 'only two' }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Missing one' }, { text: 'Present two' }] });
  A.strictEqual(r.ok, true); A.deepStrictEqual(r.results[0], { ok: false, error: 'no score returned' });
  A.strictEqual(r.results[1].score, 7); A.strictEqual(r.results[1].reason, 'only two');

  // ---- concurrency ≤ 4 and dedupe of identical concurrent texts ----
  delay = 30; maxConcurrent = 0; b = calls.length;
  const batch = [];
  for (let i = 0; i < 12; i++) batch.push(send({ type: 'analyze', items: [{ text: `Unique calm post ${i}` }] }));
  batch.push(send({ type: 'analyze', items: [{ text: 'Duplicate post' }] }));
  batch.push(send({ type: 'analyze', items: [{ text: 'Duplicate post' }] }));
  batch.push(send({ type: 'analyze', items: [{ text: 'Duplicate post' }, { text: 'Duplicate post' }] }));
  batch.push(send({ type: 'score', text: 'Duplicate post' }));
  const rs = await Promise.all(batch);
  delay = 0;
  A.strictEqual(calls.length - b, 13, 'dedupe: 12 unique + 1 duplicate text');
  A.ok(maxConcurrent <= 4, `max concurrent ${maxConcurrent}`); A.ok(maxConcurrent >= 2, 'actually parallel');
  rs.forEach((x) => A.strictEqual(x.ok, true));
  A.strictEqual(rs[14].results.length, 2); A.strictEqual(rs[14].results[0].score, 5); A.strictEqual(rs[14].results[1].score, 5);
  A.strictEqual(rs[15].score, 5);
  delay = 30; maxConcurrent = 0; b = calls.length;
  const big = []; for (let i = 0; i < 40; i++) big.push({ text: `Big batch post ${i}${i % 10 === 0 ? ' moron' : ''}` });
  r = await send({ type: 'analyze', items: big });
  delay = 0;
  A.strictEqual(calls.filter((c, i) => i >= b && schemaName(c) === 'inflammatory_scores').length, 5, '40 posts → 5 chunks');
  A.strictEqual(calls.filter((c, i) => i >= b && schemaName(c) === 'calm_rewrite').length, 4);
  A.ok(maxConcurrent <= 4, `max concurrent ${maxConcurrent}`);
  r.results.forEach((x, i) => { A.strictEqual(x.ok, true); A.strictEqual(x.score, i % 10 === 0 ? 66 : 5); });

  // ---- testKey ----
  A.deepStrictEqual(await send({ type: 'testKey', apiKey: 'sk-good' }), { ok: true });
  A.deepStrictEqual(await send({ type: 'testKey', apiKey: 'sk-bad' }), { ok: false, error: 'Invalid key' });
  A.deepStrictEqual(await send({ type: 'testKey' }), { ok: true }); // saved settings
  A.strictEqual(calls[calls.length - 1].url, 'https://api.openai.com/v1/models'); A.strictEqual(calls[calls.length - 1].auth, 'Bearer sk-test2');
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'anthropic', apiKey: 'sk-ant-good' }), { ok: true });
  let last = calls[calls.length - 1];
  A.strictEqual(last.url, 'https://api.anthropic.com/v1/models');
  A.strictEqual(last.headers['x-api-key'], 'sk-ant-good'); A.strictEqual(last.headers['anthropic-version'], '2023-06-01');
  A.strictEqual(last.headers['anthropic-dangerous-direct-browser-access'], 'true'); A.strictEqual(last.auth, undefined);
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'anthropic', apiKey: 'sk-ant-bad' }), { ok: false, error: 'Invalid key' });
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'anthropic', apiKey: '' }), { ok: false, error: 'No key' });
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: COMPAT }), { ok: false, error: 'permission' });
  grantedOrigins.push('http://localhost:11434/*');
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: COMPAT + '/' }), { ok: true });
  last = calls[calls.length - 1]; A.strictEqual(last.url, COMPAT + '/models'); A.strictEqual(last.auth, undefined, 'no auth header without a key');
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: COMPAT, apiKey: 'lm-key' }), { ok: true });
  A.strictEqual(calls[calls.length - 1].auth, 'Bearer lm-key');
  compatModels = 404;
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: COMPAT }), { ok: true, note: 'Endpoint reachable (no /models route)' });
  compatModels = 'down';
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: COMPAT }), { ok: false, error: `Can't reach ${COMPAT}` });
  compatModels = 200;
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: '' }), { ok: false, error: 'No base URL' });
  A.deepStrictEqual(await send({ type: 'testKey', provider: 'compatible', baseUrl: 'not a url' }), { ok: false, error: 'Invalid base URL' });

  // ---- pageCounts → per-tab badge ----
  badge.length = 0;
  r = await send({ type: 'pageCounts', rewritten: 2, hidden: 1 }, { tab: { id: 7 } });
  A.deepStrictEqual(r, { ok: true });
  A.ok(badgeHas('setBadgeText', { tabId: 7, text: '3' }), 'per-tab count');
  A.ok(badgeHas('setBadgeBackgroundColor', { tabId: 7, color: '#536471' }), 'grey per-tab badge');
  badge.length = 0;
  await send({ type: 'pageCounts', rewritten: 0, hidden: 0 }, { tab: { id: 7 } });
  A.ok(badgeHas('setBadgeText', { tabId: 7, text: '' }), 'empty when 0');
  A.deepStrictEqual(await send({ type: 'pageCounts', rewritten: 1, hidden: 0 }), { ok: true }, 'no tab → no-op');
  await send({ type: 'pageCounts', rewritten: 4, hidden: 0 }, { tab: { id: 7 } });

  // ---- spend cap ----
  badge.length = 0;
  await chrome.storage.local.set({ spendCap: 0.001 }); await sleep(5);
  r = await send({ type: 'getStats' });
  for (const k of ['stats', 'cacheSize', 'costTotal', 'costMonth', 'costEstimated', 'capReached', 'month']) A.ok(k in r, 'getStats has ' + k);
  A.strictEqual(r.ok, true); A.ok(r.costMonth > 0.001, `costMonth ${r.costMonth}`); A.strictEqual(r.capReached, true); A.strictEqual(r.costEstimated, false);
  A.ok(Math.abs(r.costTotal - r.costMonth) < 1e-12); A.strictEqual(r.month, r.stats.month);
  const nano = r.stats.usage['gpt-5.4-nano'], mini = r.stats.usage['gpt-5.4-mini'], gm = r.stats.usage['gpt-5-mini'];
  const expectedCost = (nano.in * 0.2 + nano.out * 1.25 + mini.in * 0.75 + mini.out * 4.5 + gm.in * 0.25 + gm.out * 2) / 1e6;
  A.ok(Math.abs(r.costTotal - expectedCost) < 1e-12, 'cost uses the price table');
  const prevMonth = r.month;
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Brand new post under cap' }] });
  A.deepStrictEqual(r, { ok: false, error: 'cap' }); A.strictEqual(calls.length, b, 'no fetch when capped');
  r = await send({ type: 'score', text: 'Brand new draft under cap' }); A.deepStrictEqual(r, { ok: false, error: 'cap' }); A.strictEqual(calls.length, b);
  A.ok(badgeHas('setBadgeText', { text: '$', tabId: undefined }), 'global $ badge');
  A.ok(badgeHas('setBadgeBackgroundColor', { color: '#c77d00', tabId: undefined }), 'amber');
  A.ok(badgeHas('setBadgeText', { text: '$', tabId: 7 }), 'open tab shows the global state');
  r = await send({ type: 'analyze', items: [items[0]] }); A.strictEqual(r.ok, true); A.strictEqual(r.results[0].score, 5); A.strictEqual(calls.length, b, 'cache hits still free');
  r = await send({ type: 'score', text: 'You absolute moron' }); A.strictEqual(r.ok, true); A.strictEqual(calls.length, b);
  badge.length = 0; await send({ type: 'pageCounts', rewritten: 1, hidden: 0 }, { tab: { id: 7 } });
  A.ok(badgeHas('setBadgeText', { tabId: 7, text: '$' })); A.ok(!badgeHas('setBadgeText', { tabId: 7, text: '1' }), 'global state wins over the count');

  // ---- month rollover resets monthUsage and lifts the cap ----
  const d = new RealDate(); fakeNow = new RealDate(d.getFullYear(), d.getMonth() + 1, 15).getTime();
  badge.length = 0;
  r = await send({ type: 'getStats' }); await sleep(5);
  A.notStrictEqual(r.month, prevMonth); A.strictEqual(r.stats.month, r.month);
  A.deepStrictEqual(r.stats.monthUsage, {}); A.strictEqual(r.costMonth, 0); A.strictEqual(r.capReached, false); A.ok(r.costTotal > 0.001, 'lifetime usage kept');
  A.ok(badgeHas('setBadgeText', { text: '', tabId: undefined }), 'badge cleared in the new month');
  A.ok(badgeHas('setBadgeText', { tabId: 7, text: '1' }), 'tab count restored');
  const newMonth = r.month;
  r = await send({ type: 'analyze', items: [{ text: 'Brand new post under cap' }] });
  A.strictEqual(r.ok, true); A.strictEqual(calls.length, b + 1, 'calls resume in the new month');
  await sleep(500); A.strictEqual(store.stats.month, newMonth); A.strictEqual(store.stats.monthUsage['gpt-5.4-nano'].calls, 1, 'fresh month usage');
  await chrome.storage.local.set({ spendCap: 10 });

  // ---- anthropic provider ----
  await chrome.storage.local.set({ provider: 'anthropic', anthropicKey: 'sk-ant-test', scoreModel: 'claude-haiku-4-5', rewriteModel: 'claude-opus-5' });
  await sleep(5);
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ id: 'a1', text: 'What a moron, honestly', lang: 'en', author: 'erin', force: false }] });
  A.strictEqual(r.ok, true); A.strictEqual(r.results[0].score, 66); A.strictEqual(r.results[0].rewrite, 'CALM: What a moron, honestly');
  A.strictEqual(calls.length, b + 2);
  const asc = calls[b], arw = calls[b + 1];
  A.strictEqual(asc.url, 'https://api.anthropic.com/v1/messages');
  A.strictEqual(asc.headers['x-api-key'], 'sk-ant-test'); A.strictEqual(asc.headers['anthropic-version'], '2023-06-01');
  A.strictEqual(asc.headers['content-type'], 'application/json'); A.strictEqual(asc.headers['anthropic-dangerous-direct-browser-access'], 'true');
  A.strictEqual(asc.headers['anthropic-beta'], undefined, 'no beta header for haiku'); A.strictEqual(asc.auth, undefined);
  A.strictEqual(asc.body.model, 'claude-haiku-4-5'); A.ok(asc.body.max_tokens > 0);
  A.deepStrictEqual(asc.body.system, [{ type: 'text', text: sc.messages[0].content, cache_control: { type: 'ephemeral' } }]);
  A.deepStrictEqual(asc.body.messages.map((m) => m.role), ['user']); A.ok(asc.body.messages[0].content.includes('### Post 1\nLanguage: en\nWhat a moron'));
  A.deepStrictEqual(asc.body.output_config, { format: { type: 'json_schema', schema: sc.response_format.json_schema.schema } });
  A.strictEqual(asc.body.fallbacks, undefined); A.ok(!('response_format' in asc.body) && !('temperature' in asc.body) && !('max_completion_tokens' in asc.body));
  A.strictEqual(arw.body.model, 'claude-opus-5'); A.strictEqual(arw.body.output_config.effort, 'low'); A.strictEqual(arw.body.fallbacks, 'default');
  A.strictEqual(arw.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  A.strictEqual(arw.body.output_config.format.type, 'json_schema'); A.deepStrictEqual(arw.body.output_config.format.schema.required, ['rewrite']);
  A.ok(arw.body.messages[0].content.includes('rated 66/100'));
  await sleep(500);
  A.strictEqual(store.stats.usage['claude-haiku-4-5'].in, 100); A.strictEqual(store.stats.usage['claude-opus-5'].out, 20);
  script.push(() => ({ status: 200, json: { content: [], stop_reason: 'refusal', usage: { input_tokens: 5, output_tokens: 0 } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Refused post' }] });
  A.strictEqual(r.ok, true); A.deepStrictEqual(r.results[0], { ok: false, error: 'Model declined this post' });
  script.push(() => ({ status: 200, json: { content: [{ type: 'text', text: '{"res' }], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 5 } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Cut off post' }] }); A.match(r.results[0].error, /cut off/);
  await chrome.storage.local.set({ scoreModel: 'claude-sonnet-5' });
  script.push((body) => body.output_config.effort ? ({ status: 400, json: { error: { type: 'invalid_request_error', message: 'effort is not supported on this model' } } }) : undefined);
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Sonnet scored post' }] });
  A.strictEqual(r.results[0].score, 5); A.strictEqual(calls.length, b + 2);
  A.strictEqual(calls[b].body.output_config.effort, 'low'); A.strictEqual(calls[b].body.fallbacks, undefined); A.strictEqual(calls[b].headers['anthropic-beta'], undefined);
  A.strictEqual(calls[b + 1].body.output_config.effort, undefined, 'retried without effort');
  script.push(() => ({ status: 429, json: { error: { type: 'rate_limit_error', message: 'slow' } }, headers: { 'retry-after': '0.01' } }));
  b = calls.length; r = await send({ type: 'analyze', items: [{ text: 'Rate limited post' }] });
  A.strictEqual(r.results[0].ok, true); A.strictEqual(calls.length, b + 2, 'anthropic 429 retried');
  badge.length = 0;
  script.push(() => ({ status: 401, json: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
  r = await send({ type: 'analyze', items: [{ text: 'Bad anthropic key post' }] });
  A.strictEqual(r.results[0].error, 'Invalid Anthropic API key'); A.ok(badgeHas('setBadgeText', { text: '!', tabId: undefined }));
  b = calls.length; r = await send({ type: 'analyze', items: [{ text: 'Post after a rejected anthropic key' }] });
  A.strictEqual(r.ok, false); A.match(r.error, /rejected/); A.strictEqual(calls.length, b, 'rejected key: no fetch until the key changes');
  await chrome.storage.local.set({ anthropicKey: 'sk-ant-b' }); await sleep(5);
  r = await send({ type: 'getStats' }); A.strictEqual(r.costEstimated, false);
  await chrome.storage.local.set({ scoreModel: 'claude-haiku-4-5-20251001' });
  await send({ type: 'analyze', items: [{ text: 'Dated snapshot post' }] });
  r = await send({ type: 'getStats' }); A.strictEqual(r.costEstimated, false, 'dated snapshot priced by prefix');
  A.strictEqual(r.stats.usage['claude-haiku-4-5-20251001'].calls, 1);
  await chrome.storage.local.set({ scoreModel: 'mystery-model' });
  await send({ type: 'analyze', items: [{ text: 'Unknown model post' }] });
  r = await send({ type: 'getStats' }); A.strictEqual(r.costEstimated, true, 'unknown model flagged as estimated');

  // ---- compatible provider ----
  await chrome.storage.local.set({ provider: 'compatible', baseUrl: COMPAT + '/', compatibleKey: '', scoreModel: 'llama3', rewriteModel: 'llama3' });
  await sleep(5);
  badge.length = 0;
  b = calls.length;
  script.push((body) => body.response_format && body.response_format.type === 'json_schema' ? ({ status: 400, json: { error: { message: "'response_format.type' must be 'json_object' or 'text'" } } }) : undefined);
  r = await send({ type: 'analyze', items: [{ text: 'Local model post' }] });
  A.strictEqual(r.ok, true); A.strictEqual(r.results[0].score, 5); A.strictEqual(calls.length, b + 2);
  A.strictEqual(calls[b].url, COMPAT + '/chat/completions'); A.strictEqual(calls[b].auth, undefined, 'no Authorization without a key');
  A.strictEqual(calls[b].body.response_format.type, 'json_schema'); A.deepStrictEqual(calls[b + 1].body.response_format, { type: 'json_object' }, 'degraded to json_object');
  A.strictEqual(calls[b].body.model, 'llama3'); A.strictEqual(calls[b].body.reasoning_effort, undefined);
  script.push(() => ({ status: 400, json: { error: { message: 'response_format is not supported' } } }));
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Local model post two' }] });
  A.strictEqual(r.results[0].score, 5); A.strictEqual(calls.length, b + 2);
  A.deepStrictEqual(calls[b].body.response_format, { type: 'json_object' }, 'remembers the degraded format');
  A.ok(!('response_format' in calls[b + 1].body), 'degraded to none; fenced reply parsed leniently');
  await chrome.storage.local.set({ compatibleKey: 'lm-key' }); await sleep(5);
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ text: 'Local model post three' }] });
  A.strictEqual(r.results[0].score, 5); A.strictEqual(calls.length, b + 1); A.strictEqual(calls[b].auth, 'Bearer lm-key'); A.ok(!('response_format' in calls[b].body));
  A.ok(!badgeHas('setBadgeText', { text: '!', tabId: undefined }), 'compatible without a key is not no-key');
  await chrome.storage.local.set({ baseUrl: '' }); await sleep(5);
  r = await send({ type: 'analyze', items: [{ text: 'whatever' }] }); A.deepStrictEqual(r, { ok: false, error: 'no-key' });
  A.ok(badgeHas('setBadgeText', { text: '!', tabId: undefined }), 'no base URL → ! badge');

  // ---- onboarding ----
  A.deepStrictEqual(await send({ type: 'openOnboarding' }), { ok: true });
  A.deepStrictEqual(tabsCreated[0], { url: 'chrome-extension://nms/onboarding/onboarding.html' });
  onInstalled({ reason: 'install' }); A.strictEqual(tabsCreated.length, 2, 'opened on install');
  onInstalled({ reason: 'update' }); A.strictEqual(tabsCreated.length, 2, 'not on update');

  // ---- disabled ----
  await chrome.storage.local.set({ provider: 'openai', enabled: false }); await sleep(5);
  r = await send({ type: 'analyze', items: [{ text: 'x' }] }); A.deepStrictEqual(r, { ok: false, error: 'disabled' });
  r = await send({ type: 'score', text: 'x' }); A.deepStrictEqual(r, { ok: false, error: 'disabled' });
  await chrome.storage.local.set({ enabled: true });

  // ---- clearCache / resetStats / unknown message ----
  r = await send({ type: 'getStats' }); A.ok(r.cacheSize >= 60, `cacheSize ${r.cacheSize}`);
  await send({ type: 'clearCache' });
  A.strictEqual(Object.keys(store).filter((k) => k.startsWith('c:')).length, 0);
  A.ok(store['a:alice'], 'author history survives clearCache');
  r = await send({ type: 'getStats' }); A.strictEqual(r.cacheSize, 0);
  await send({ type: 'resetStats' });
  A.strictEqual(store.stats.scored, 0); A.deepStrictEqual(store.stats.usage, {}); A.deepStrictEqual(store.stats.monthUsage, {});
  r = await send({ type: 'getStats' }); A.strictEqual(r.costTotal, 0); A.strictEqual(r.capReached, false);
  r = await send({ type: 'bogus' }); A.strictEqual(r.ok, false);

  // ---- calibration: none → the scoring system message is the bare constant ----
  await chrome.storage.local.set({ scoreModel: 'gpt-5.4-nano', rewriteModel: 'gpt-5.4-mini', calibration: [] }); await sleep(5);
  A.strictEqual(store.calibration.length, 0);
  b = calls.length;
  const calmText = 'Calibration base calm post', hotText = 'Calibration base post, what a moron';
  r = await send({ type: 'analyze', items: [{ id: 'k1', text: calmText, lang: '', author: 'fran', force: false }, { id: 'k2', text: hotText, lang: '', author: 'fran', force: false }] });
  A.strictEqual(r.ok, true); A.strictEqual(r.results[0].score, 5); A.strictEqual(r.results[1].score, 66);
  A.strictEqual(r.results[1].rewrite, 'CALM: ' + hotText); A.strictEqual(calls.length, b + 2);
  const baseSystem = calls[b].body.messages[0].content;
  A.strictEqual(baseSystem, sc.messages[0].content, 'no calibration → the constant prompt, byte-identical to earlier calls');
  A.ok(!baseSystem.includes("## This user's calibration"), 'no calibration block');
  A.ok(baseSystem.endsWith("using each post's number as its index."), 'constant ends where it always did');
  const hotKey = Object.keys(store).find((k) => k.startsWith('c:') && store[k].w === 'CALM: ' + hotText);
  const calmKey = Object.keys(store).find((k) => k.startsWith('c:') && store[k].s === 5 && store[k].w === undefined);
  A.ok(hotKey && calmKey, 'both entries cached'); A.strictEqual(store[hotKey].s, 66); A.strictEqual(store[hotKey].wk, 'neutral');
  r = await send({ type: 'getStats' }); A.strictEqual(r.cacheSize, 2);

  // ---- setting calibration drops s/r from cached entries (memory + storage) but keeps w ----
  const cal = [
    { id: 'x1', text: 'He said "no way"\nand\r\nleft', score: 30 },
    { id: 'x2', text: 'What a "lovely" day', score: 10 },
  ];
  await chrome.storage.local.set({ calibration: cal }); await sleep(5);
  A.deepStrictEqual(Object.keys(store[hotKey]).sort(), ['t', 'w', 'wk'], 's and r dropped, w/wk/t kept');
  A.strictEqual(store[hotKey].w, 'CALM: ' + hotText); A.strictEqual(store[hotKey].wk, 'neutral'); A.strictEqual(typeof store[hotKey].t, 'number');
  A.strictEqual(store[calmKey], undefined, 'entry with no rewrite removed entirely');
  r = await send({ type: 'getStats' }); A.strictEqual(r.cacheSize, 1, 'in-memory cache pruned too');
  A.ok(store['a:alice'], 'author history untouched by calibration');

  // ---- the next scoring call carries the block: shared prefix unchanged, both lines, escaped quotes ----
  const calBlock = "\n\n## This user's calibration\nThe person reading these posts rated the following examples themselves. Match their scale: when a post resembles one of these, score it the way they did.\n"
    + '- "He said \\"no way\\" and left" → 30\n'
    + '- "What a \\"lovely\\" day" → 10';
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ id: 'k2', text: hotText, lang: '', author: 'fran', force: false }] });
  A.strictEqual(r.ok, true); A.strictEqual(r.results[0].score, 66); A.strictEqual(r.results[0].rewrite, 'CALM: ' + hotText);
  A.strictEqual(calls.length, b + 1, 'rescored once, rewrite reused'); A.strictEqual(schemaName(calls[b]), 'inflammatory_scores');
  const calSystem = calls[b].body.messages[0].content;
  A.ok(calSystem.startsWith(baseSystem), 'shared prefix byte-identical');
  A.strictEqual(calSystem, baseSystem + calBlock, 'block appended verbatim');
  A.ok(calSystem.endsWith(calBlock));
  A.strictEqual(store[hotKey].s, 66); A.strictEqual(store[hotKey].w, 'CALM: ' + hotText, 'rewrite still cached after rescoring');
  r = await send({ type: 'score', text: hotText }); A.strictEqual(calls.length, b + 1, 'cached again');
  r = await send({ type: 'analyze', items: [{ id: 'k1', text: calmText, lang: '', author: 'fran', force: false }] });
  A.strictEqual(calls.length, b + 2); A.strictEqual(r.results[0].score, 5); A.strictEqual(calls[b + 1].body.messages[0].content, calSystem, 'deterministic for the same calibration');
  // rewrite prompt never carries the block
  r = await send({ type: 'analyze', items: [{ id: 'k3', text: 'Fresh idiot post', lang: '', author: 'fran', force: false }] });
  A.strictEqual(calls.length, b + 4); A.strictEqual(schemaName(calls[b + 3]), 'calm_rewrite');
  A.ok(calls[b + 3].body.messages[0].content.startsWith('You rewrite')); A.ok(!calls[b + 3].body.messages[0].content.includes('calibration'), 'rewrite prompt unchanged');
  // writing the same calibration again is a no-op: nothing dropped
  await chrome.storage.local.set({ calibration: cal.map((e) => ({ ...e })) }); await sleep(5);
  A.strictEqual(store[hotKey].s, 66, 'same calibration → scores kept');
  r = await send({ type: 'score', text: hotText }); A.strictEqual(calls.length, b + 4);
  // anthropic gets the same appended system text
  await chrome.storage.local.set({ provider: 'anthropic', scoreModel: 'claude-haiku-4-5' }); await sleep(5);
  r = await send({ type: 'score', text: 'Anthropic calibrated post' });
  A.strictEqual(calls[calls.length - 1].body.system[0].text, calSystem);
  await chrome.storage.local.set({ provider: 'openai', scoreModel: 'gpt-5.4-nano' }); await sleep(5);

  // ---- malformed entries are ignored; scores clamped; capped at 24; non-array → no block ----
  await chrome.storage.local.set({ calibration: [
    { id: 'ok1', text: 'Fine post', score: 150 },
    { id: 'bad1', text: '', score: 50 }, { id: 'bad2', text: '   ', score: 50 },
    { id: 'bad3', text: 'no score' }, { id: 'bad4', text: 'string score', score: '50' },
    { id: 'bad5', text: 42, score: 50 }, { id: 'bad6', text: 'nan', score: NaN }, { id: 'bad7', text: 'inf', score: Infinity },
    null, 'just a string', 7, { id: 'ok2', text: 'Negative', score: -5 },
  ] }); await sleep(5);
  A.strictEqual(store[hotKey].s, undefined, 'a different calibration drops scores again');
  b = calls.length;
  r = await send({ type: 'score', text: 'Post after malformed calibration' }); A.strictEqual(r.ok, true);
  A.strictEqual(calls[b].body.messages[0].content, baseSystem + calBlock.slice(0, calBlock.indexOf('- "')) + '- "Fine post" → 100\n- "Negative" → 0');
  const tooMany = []; for (let i = 0; i < 30; i++) tooMany.push({ id: 'm' + i, text: 'Many ' + i, score: i });
  await chrome.storage.local.set({ calibration: tooMany }); await sleep(5);
  b = calls.length;
  r = await send({ type: 'score', text: 'Post after 30 calibration entries' });
  const lines = calls[b].body.messages[0].content.slice(baseSystem.length).split('\n').filter((l) => l.startsWith('- "'));
  A.strictEqual(lines.length, 24, 'capped at 24'); A.strictEqual(lines[0], '- "Many 0" → 0'); A.strictEqual(lines[23], '- "Many 23" → 23');
  await chrome.storage.local.set({ calibration: [null, { text: '', score: 1 }] }); await sleep(5);
  b = calls.length;
  r = await send({ type: 'score', text: 'Post after only-bad calibration' });
  A.strictEqual(calls[b].body.messages[0].content, baseSystem, 'only malformed entries → no block');
  await chrome.storage.local.set({ calibration: 'junk' }); await sleep(5);
  r = await send({ type: 'score', text: 'Post after only-bad calibration' }); A.strictEqual(calls.length, b + 1, 'malformed → malformed is not a change');
  b = calls.length;
  r = await send({ type: 'score', text: 'Post after junk calibration' });
  A.strictEqual(calls[b].body.messages[0].content, baseSystem, 'non-array → no block');

  // ---- scoreMany: one call for 8 texts, ordered results, no rewrite, no author history ----
  await chrome.storage.local.set({ calibration: [] }); await sleep(5);
  const authorKeys = () => Object.keys(store).filter((k) => k.startsWith('a:')).sort();
  const aBefore = authorKeys();
  b = calls.length;
  const manyTexts = []; for (let i = 0; i < 8; i++) manyTexts.push(`scoreMany post ${i}${i === 3 ? ' moron' : i === 6 ? ' vermin' : ''}`);
  r = await send({ type: 'scoreMany', texts: manyTexts });
  A.strictEqual(r.ok, true); A.strictEqual(r.results.length, 8);
  A.strictEqual(calls.length, b + 1, 'exactly one API call for 8 texts'); A.strictEqual(schemaName(calls[b]), 'inflammatory_scores');
  A.strictEqual(postsOf(calls[b].body.messages[1].content).length, 8);
  A.strictEqual(calls[b].body.messages[0].content, baseSystem);
  r.results.forEach((x, i) => A.deepStrictEqual(x, { ok: true, score: fakeScore(manyTexts[i]), reason: 'fake reason' }, 'scoreMany result ' + i));
  A.strictEqual(r.results[3].score, 66); A.strictEqual(r.results[6].score, 90);
  A.deepStrictEqual(authorKeys(), aBefore, 'no a: key written');
  A.ok(Object.keys(store).some((k) => k.startsWith('c:') && store[k].s === 66 && store[k].w === undefined), 'flagged text cached without a rewrite');
  r = await send({ type: 'scoreMany', texts: manyTexts }); A.strictEqual(r.ok, true); A.strictEqual(calls.length, b + 1, 'scoreMany cache hits make no calls');
  r = await send({ type: 'scoreMany', texts: [manyTexts[6], manyTexts[3]] });
  A.deepStrictEqual(r.results.map((x) => x.score), [90, 66], 'order follows the request'); A.strictEqual(calls.length, b + 1);
  r = await send({ type: 'score', text: manyTexts[3] }); A.strictEqual(r.score, 66); A.strictEqual(calls.length, b + 1, 'shared cache with score');
  r = await send({ type: 'scoreMany', texts: [manyTexts[0], 42, '', '   ', null, manyTexts[0]] });
  A.strictEqual(r.ok, true); A.strictEqual(calls.length, b + 1); A.strictEqual(r.results.length, 6);
  A.deepStrictEqual(r.results[0], { ok: true, score: 5, reason: 'fake reason' }); A.deepStrictEqual(r.results[5], r.results[0]);
  for (let i = 1; i < 5; i++) { A.strictEqual(r.results[i].ok, false, 'per-item error ' + i); A.strictEqual(typeof r.results[i].error, 'string'); }
  A.deepStrictEqual(await send({ type: 'scoreMany', texts: [] }), { ok: true, results: [] });
  r = await send({ type: 'scoreMany', texts: 'nope' }); A.strictEqual(r.ok, false);
  r = await send({ type: 'scoreMany' }); A.strictEqual(r.ok, false);
  const nine = []; for (let i = 0; i < 9; i++) nine.push(`scoreMany chunk post ${i}`);
  b = calls.length; r = await send({ type: 'scoreMany', texts: nine });
  A.strictEqual(calls.length, b + 2, '9 texts → 8 + 1'); A.strictEqual(r.results.length, 9); r.results.forEach((x) => A.strictEqual(x.score, 5));
  script.push(() => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ results: [{ index: 1, score: 7, reason: 'only one' }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }));
  r = await send({ type: 'scoreMany', texts: ['scoreMany present', 'scoreMany missing'] });
  A.strictEqual(r.ok, true); A.deepStrictEqual(r.results[0], { ok: true, score: 7, reason: 'only one' }); A.deepStrictEqual(r.results[1], { ok: false, error: 'no score returned' });
  // disabled / no-key / cap, like `score`
  await chrome.storage.local.set({ enabled: false }); await sleep(5);
  A.deepStrictEqual(await send({ type: 'scoreMany', texts: ['x'] }), { ok: false, error: 'disabled' });
  await chrome.storage.local.set({ enabled: true, apiKey: '' }); await sleep(5);
  A.deepStrictEqual(await send({ type: 'scoreMany', texts: ['x'] }), { ok: false, error: 'no-key' });
  await chrome.storage.local.set({ apiKey: 'sk-test2', spendCap: 0.000001 }); await sleep(5);
  r = await send({ type: 'getStats' }); A.strictEqual(r.capReached, true);
  b = calls.length;
  A.deepStrictEqual(await send({ type: 'scoreMany', texts: ['scoreMany brand new under cap'] }), { ok: false, error: 'cap' }); A.strictEqual(calls.length, b);
  A.deepStrictEqual(await send({ type: 'scoreMany', texts: [manyTexts[0], 'scoreMany brand new under cap'] }), { ok: false, error: 'cap' }); A.strictEqual(calls.length, b);
  r = await send({ type: 'scoreMany', texts: manyTexts.slice(0, 2).concat(['']) });
  A.strictEqual(r.ok, true); A.strictEqual(r.results[0].score, 5); A.strictEqual(r.results[2].ok, false); A.strictEqual(calls.length, b, 'cache hits still free under cap');
  await chrome.storage.local.set({ spendCap: 10 }); await sleep(5);

  // ---- openOnboarding with a hash ----
  const tabsBefore = tabsCreated.length;
  A.deepStrictEqual(await send({ type: 'openOnboarding', hash: 'calibrate' }), { ok: true });
  A.strictEqual(tabsCreated.length, tabsBefore + 1);
  A.deepStrictEqual(tabsCreated[tabsCreated.length - 1], { url: 'chrome-extension://nms/onboarding/onboarding.html#calibrate' });
  A.ok(tabsCreated[tabsCreated.length - 1].url.endsWith('#calibrate'));
  await send({ type: 'openOnboarding', hash: 'Bad Hash!' });
  A.deepStrictEqual(tabsCreated[tabsCreated.length - 1], { url: 'chrome-extension://nms/onboarding/onboarding.html' }, 'invalid hash ignored');
  await send({ type: 'openOnboarding', hash: '' });
  A.deepStrictEqual(tabsCreated[tabsCreated.length - 1], { url: 'chrome-extension://nms/onboarding/onboarding.html' }, 'empty hash → no #');
  await send({ type: 'openOnboarding' });
  A.deepStrictEqual(tabsCreated[tabsCreated.length - 1], { url: 'chrome-extension://nms/onboarding/onboarding.html' }, 'no hash → unchanged');

  // ---- rewrite prompt: must always change something; user context names the reader's flag ----
  const rwText = 'You are a moron, retry test';
  r = await send({ type: 'score', text: rwText }); A.strictEqual(r.score, 66); // score first so analyze below only rewrites
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ id: 'rw1', text: rwText, lang: 'en', author: '', force: false }] });
  A.strictEqual(calls.length, b + 1); A.strictEqual(schemaName(calls[b]), 'calm_rewrite'); A.strictEqual(r.results[0].rewrite, 'CALM: ' + rwText);
  const rwSystem = calls[b].body.messages[0].content;
  A.ok(rwSystem.includes('Never return the text unchanged'), 'always-change rule present');
  A.ok(!rwSystem.includes('return it unchanged'), 'old return-unchanged rule gone');
  A.ok(rwSystem.includes('at minimum replace the most hostile phrase'));
  A.ok(rwSystem.includes('Never longer than the original') && rwSystem.includes('Keep every claim') && rwSystem.includes('Keep @mentions'), 'other rules kept');
  A.ok(calls[b].body.messages[1].content.startsWith('The reader flagged this post (rated 66/100: fake reason). Rewrite it.\n\nPost (language: en):\n' + rwText), 'context line');
  A.ok(!calls[b].body.messages[1].content.includes('identical to the input'), 'no retry line on the first attempt');

  // ---- identical rewrite → one retry with the push-back line; second identical answer returned as-is ----
  const rewriteReply = (text) => () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ rewrite: text }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
  const rwText2 = 'Such an idiot, retry once';
  r = await send({ type: 'score', text: rwText2 }); A.strictEqual(r.score, 66);
  script.push(rewriteReply('  Such an  idiot, retry once\n')); // input verbatim modulo whitespace…
  script.push(rewriteReply('Such a mistake, retry once'));       // …then a changed text
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ id: 'rw2', text: rwText2, lang: '', author: '', force: false }] });
  A.strictEqual(calls.length, b + 2, 'retried once'); A.strictEqual(schemaName(calls[b]), 'calm_rewrite'); A.strictEqual(schemaName(calls[b + 1]), 'calm_rewrite');
  A.strictEqual(r.results[0].rewrite, 'Such a mistake, retry once', 'second answer used');
  A.ok(!calls[b].body.messages[1].content.includes('identical to the input'));
  A.ok(calls[b + 1].body.messages[1].content.endsWith('\n\nYour previous answer was identical to the input; you must change the hostile wording.'), 'push-back line appended');
  A.strictEqual(calls[b + 1].body.messages[1].content.slice(0, calls[b].body.messages[1].content.length), calls[b].body.messages[1].content, 'same message otherwise');
  A.strictEqual(calls[b + 1].body.messages[0].content, rwSystem, 'same system prompt on retry');
  r = await send({ type: 'analyze', items: [{ id: 'rw2', text: rwText2, lang: '', author: '', force: false }] }); A.strictEqual(calls.length, b + 2, 'retried rewrite cached');
  const rwText3 = 'Moron twice over';
  r = await send({ type: 'score', text: rwText3 }); A.strictEqual(r.score, 66);
  script.push(rewriteReply(rwText3)); script.push(rewriteReply(rwText3 + ' '));
  b = calls.length;
  r = await send({ type: 'analyze', items: [{ id: 'rw3', text: rwText3, lang: '', author: '', force: false }] });
  A.strictEqual(calls.length, b + 2, 'only one retry'); A.strictEqual(r.results[0].ok, true); A.strictEqual(r.results[0].flagged, true);
  A.strictEqual(r.results[0].rewrite, rwText3, 'second identical answer returned as-is');
  r = await send({ type: 'analyze', items: [{ id: 'rw3', text: rwText3, lang: '', author: '', force: false }] }); A.strictEqual(calls.length, b + 2, 'identical rewrite cached, not re-requested');
  await sleep(500); A.strictEqual(store.stats.rewritten, 5, 'each rewritten post counted once (retries do not double count)');

  console.log(`background tests passed (${assertions} assertions, ${calls.length} fake API calls)`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
