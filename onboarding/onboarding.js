'use strict';

// Firefox exposes promise-returning APIs on `browser`; Chrome on `chrome`.
const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

const PROVIDERS = {
  openai: {
    keyField: 'apiKey', label: 'OpenAI API key', placeholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys', keyLink: 'Get an OpenAI key',
    scoreModel: 'gpt-5.4-nano', rewriteModel: 'gpt-5.4-mini',
  },
  anthropic: {
    keyField: 'anthropicKey', label: 'Anthropic API key', placeholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys', keyLink: 'Get an Anthropic key',
    scoreModel: 'claude-haiku-4-5', rewriteModel: 'claude-opus-5',
  },
  compatible: {
    keyField: 'compatibleKey', label: 'API key (optional)', placeholder: 'leave empty for Ollama',
    keyUrl: null, keyLink: '',
    scoreModel: '', rewriteModel: '',
  },
};

const DEFAULTS = {
  provider: 'openai', apiKey: '', anthropicKey: '', compatibleKey: '', baseUrl: '',
  cutoff: 40, scoreModel: 'gpt-5.4-nano', rewriteModel: 'gpt-5.4-mini',
  calibration: [],
};

// Firefox treats manifest host_permissions as optional and doesn't grant them at install.
const SITE_ORIGINS = ['https://x.com/*', 'https://twitter.com/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*'];

// Example posts and bands (onboarding/calibration-posts.js).
const CAL = window.NMS_CALIBRATION || { bands: [], posts: [], check: [] };
const BANDS = CAL.bands;

const $ = (id) => document.getElementById(id);
const el = {
  seg: [...document.querySelectorAll('.seg[aria-label="Provider"] .seg-btn')],
  baseUrlField: $('baseUrlField'), baseUrl: $('baseUrl'), originStatus: $('originStatus'), allowOrigin: $('allowOrigin'),
  keyLabel: $('keyLabel'), apiKey: $('apiKey'), reveal: $('reveal'), keyStatus: $('keyStatus'),
  modelField: $('modelField'), customModel: $('customModel'),
  getKey: $('getKey'), customNote: $('customNote'),
  calPosts: $('calPosts'), calProgress: $('calProgress'), calSkip: $('calSkip'),
  calCheck: $('calCheck'), calCheckBtn: $('calCheckBtn'), calCheckStatus: $('calCheckStatus'),
  calCheckResults: $('calCheckResults'), calCheckNote: $('calCheckNote'),
  cutoff: $('cutoff'), cutoffValue: $('cutoffValue'), cutoffHint: $('cutoffHint'), cutoffBands: $('cutoffBands'),
  thresholdStep: $('threshold'),
  firefoxBlock: $('firefoxBlock'), grantHosts: $('grantHosts'), hostStatus: $('hostStatus'),
  openX: $('openX'), saved: $('saved'),
};

let current = { ...DEFAULTS };

function save(patch) {
  Object.assign(current, patch);
  return api.storage.local.set(patch).then(flashSaved);
}

let savedTimer;
function flashSaved() {
  el.saved.textContent = 'Saved';
  el.saved.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.saved.classList.remove('show'), 1200);
}

function setStatus(node, text, kind) {
  node.className = `sub status${node === el.originStatus || node === el.hostStatus || node === el.calCheckStatus ? ' grow' : ''}${kind ? ' ' + kind : ''}`;
  node.textContent = text;
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Same colour formula as the badges in the extension (content/common.js).
function scoreColor(score) {
  const hue = Math.max(0, Math.min(120, 120 - score * 1.2));
  return `hsl(${hue.toFixed(0)} 72% 44%)`;
}

// The highest band whose range starts at or below the score: 0–19 Fine, 20–39 Snarky, … 80+ Abusive.
function bandFor(score) {
  let band = BANDS[0];
  for (const b of BANDS) if (b.score - 10 <= score) band = b;
  return band;
}

// Nearest band to a stored score (stored scores are band values, but be forgiving).
function bandByScore(score) {
  let best = null;
  for (const b of BANDS) if (!best || Math.abs(b.score - score) < Math.abs(best.score - score)) best = b;
  return best;
}

function cutoffHint(v) {
  if (v <= 15) return 'Rewrites almost everything with any edge to it';
  if (v <= 35) return 'Rewrites snark and sarcasm, leaves earnest opinions alone';
  if (v <= 55) return 'Rewrites hostile or contemptuous posts';
  if (v <= 75) return 'Rewrites only insults, name-calling and rage bait';
  if (v <= 95) return 'Rewrites only slurs, threats and the very worst';
  return 'Rewrites nothing; scores only';
}

// "Rewrites posts you'd rate Hostile, Cruel or Abusive": a band is in when its score >= the slider.
function cutoffBands(v) {
  const names = BANDS.filter((b) => b.score >= v).map((b) => b.label);
  if (!names.length) return 'Rewrites nothing you rated';
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
  return `Rewrites posts you'd rate ${list}`;
}

function setCutoffUI(v) {
  el.cutoff.value = v;
  el.cutoffValue.textContent = v;
  el.cutoffHint.textContent = cutoffHint(v);
  el.cutoffBands.textContent = cutoffBands(v);
}

// ---- Step 1: provider and key ----

function applyProvider(p) {
  const cfg = PROVIDERS[p];
  for (const b of el.seg) b.setAttribute('aria-checked', String(b.dataset.provider === p));
  el.keyLabel.textContent = cfg.label;
  el.apiKey.placeholder = cfg.placeholder;
  el.apiKey.value = current[cfg.keyField] || '';
  el.baseUrlField.hidden = p !== 'compatible';
  el.modelField.hidden = p !== 'compatible';
  el.customNote.hidden = p !== 'compatible';
  el.getKey.hidden = !cfg.keyUrl;
  if (cfg.keyUrl) { el.getKey.href = cfg.keyUrl; el.getKey.textContent = cfg.keyLink; }
  if (p === 'compatible') {
    el.baseUrl.value = current.baseUrl;
    el.customModel.value = current.scoreModel;
    if (current.baseUrl) originCheck(current.baseUrl, false);
  }
  checkKey();
}

// True when the active provider can be called at all: a key, or a custom endpoint with a base URL.
function hasKey() {
  const p = current.provider;
  return p === 'compatible' ? !!current.baseUrl : !!(current[PROVIDERS[p].keyField] || '');
}

let keyCheck = 0;
async function checkKey() {
  const p = current.provider;
  const key = current[PROVIDERS[p].keyField] || '';
  const id = ++keyCheck;
  el.calCheck.hidden = !hasKey();
  if (p === 'compatible') {
    if (!current.baseUrl) { setStatus(el.keyStatus, 'Enter the base URL first.', ''); return; }
    if (!current.scoreModel) { setStatus(el.keyStatus, 'Enter a model id below.', ''); return; }
  } else if (!key) {
    setStatus(el.keyStatus, 'Paste a key to start.', '');
    return;
  }
  setStatus(el.keyStatus, 'Checking…', '');
  let res;
  try {
    res = await api.runtime.sendMessage({ type: 'testKey', provider: p, apiKey: key, baseUrl: current.baseUrl });
  } catch (e) {
    res = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  if (id !== keyCheck) return;
  if (res && res.ok) setStatus(el.keyStatus, res.note || (p === 'compatible' ? 'Endpoint works' : 'Key works'), 'ok');
  else setStatus(el.keyStatus, (res && res.error) || 'Could not verify the key', 'bad');
}

function normalizeBaseUrl(v) {
  v = (v || '').trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
}

// Makes sure the extension may reach the custom endpoint's origin. `ask` controls whether to
// prompt (permissions.request needs a user gesture; the change event and the button both count).
async function originCheck(url, ask) {
  let origin;
  try { origin = new URL(url).origin; } catch { setStatus(el.originStatus, 'That doesn’t look like a URL.', 'bad'); el.allowOrigin.hidden = true; return false; }
  const pattern = `${origin}/*`;
  let has = false;
  try { has = await api.permissions.contains({ origins: [pattern] }); } catch { /* ignore */ }
  if (!has && ask) {
    try { has = await api.permissions.request({ origins: [pattern] }); } catch { /* not a user gesture, or denied */ }
  }
  if (has) {
    setStatus(el.originStatus, `Access to ${origin} allowed.`, 'ok');
    el.allowOrigin.hidden = true;
  } else {
    setStatus(el.originStatus, `Allow access to ${origin} so the extension can reach it.`, 'bad');
    el.allowOrigin.hidden = false;
  }
  return has;
}

async function commitBaseUrl() {
  const url = normalizeBaseUrl(el.baseUrl.value);
  el.baseUrl.value = url;
  if (url !== current.baseUrl) await save({ baseUrl: url });
  if (!url) { setStatus(el.originStatus, '', ''); el.allowOrigin.hidden = true; checkKey(); return; }
  await originCheck(url, true);
  checkKey();
}

// ---- Step 2: calibration ----

// post id → band key for the posts the user has rated.
const picks = new Map();

function loadPicks() {
  picks.clear();
  const arr = Array.isArray(current.calibration) ? current.calibration : [];
  for (const it of arr) {
    if (!it || typeof it.id !== 'string' || !CAL.posts.some((p) => p.id === it.id)) continue;
    const b = bandByScore(Number(it.score));
    if (b) picks.set(it.id, b.key);
  }
}

// The stored shape: graded posts in post order, { id, text, score } with score = the band's value.
function calibrationArray() {
  const out = [];
  for (const p of CAL.posts) {
    const key = picks.get(p.id);
    if (!key) continue;
    const b = BANDS.find((x) => x.key === key);
    if (b) out.push({ id: p.id, text: p.text, score: b.score });
  }
  return out;
}

function commitPicks() {
  syncCalibrationUI();
  save({ calibration: calibrationArray() });
}

function renderCalibration() {
  el.calPosts.textContent = '';
  CAL.posts.forEach((post, i) => {
    const card = mk('div', 'cal-card');
    card.dataset.id = post.id;
    card.appendChild(mk('p', 'cal-text', post.text));
    const seg = mk('div', 'seg cal-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', `Your rating for post ${i + 1} of ${CAL.posts.length}`);
    for (const b of BANDS) {
      const btn = mk('button', 'seg-btn');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.band = b.key;
      btn.title = b.hint;
      btn.tabIndex = -1;
      const dot = mk('span', 'dot');
      dot.style.background = scoreColor(b.score);
      dot.setAttribute('aria-hidden', 'true');
      btn.append(dot, document.createTextNode(b.label));
      // Clicking the chosen band again un-grades the post.
      btn.addEventListener('click', () => {
        if (picks.get(post.id) === b.key) picks.delete(post.id); else picks.set(post.id, b.key);
        commitPicks();
      });
      seg.appendChild(btn);
    }
    seg.addEventListener('keydown', (e) => segKeydown(e, post));
    card.appendChild(seg);
    card.appendChild(mk('div', 'cal-rubric'));
    el.calPosts.appendChild(card);
  });
  syncCalibrationUI();
}

function syncCalibrationUI() {
  for (const card of el.calPosts.children) {
    const post = CAL.posts.find((p) => p.id === card.dataset.id);
    const picked = picks.get(card.dataset.id);
    const btns = [...card.querySelectorAll('.seg-btn')];
    btns.forEach((b, i) => {
      const on = b.dataset.band === picked;
      b.setAttribute('aria-checked', String(on));
      // Roving tabindex: the chosen band is the group's tab stop, or the first band before a choice.
      b.tabIndex = (picked ? on : i === 0) ? 0 : -1;
    });
    const suggested = post && BANDS.find((b) => b.key === post.suggested);
    card.querySelector('.cal-rubric').textContent = picked && suggested ? `rubric says ${suggested.label}` : '';
  }
  el.calProgress.textContent = `${picks.size} of ${CAL.posts.length} rated`;
}

// Arrow keys move within a group and select, as native radios do; Home/End jump to the ends.
function segKeydown(e, post) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' }[e.key];
  if (step === undefined) return;
  const btns = [...e.currentTarget.querySelectorAll('.seg-btn')];
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const j = step === 'first' ? 0 : step === 'last' ? btns.length - 1 : (i + step + btns.length) % btns.length;
  const b = btns[j];
  if (picks.get(post.id) !== b.dataset.band) { picks.set(post.id, b.dataset.band); commitPicks(); }
  b.focus();
}

// "Check the scale": score the held-out posts with the model and show what it does with this scale.
let checkRun = 0;
async function runCheck() {
  const id = ++checkRun;
  const label = el.calCheckBtn.textContent;
  el.calCheckBtn.disabled = true;
  el.calCheckBtn.classList.add('busy');
  el.calCheckBtn.textContent = 'Scoring…';
  el.calCheckResults.setAttribute('aria-busy', 'true');
  setStatus(el.calCheckStatus, 'Asking the model…', '');
  let res;
  try {
    res = await api.runtime.sendMessage({ type: 'scoreMany', texts: CAL.check.map((p) => p.text) });
  } catch (e) {
    res = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  if (id !== checkRun) return;
  el.calCheckBtn.disabled = false;
  el.calCheckBtn.classList.remove('busy');
  el.calCheckBtn.textContent = label;
  el.calCheckResults.removeAttribute('aria-busy');
  if (!res || !res.ok) { setStatus(el.calCheckStatus, checkError(res && res.error), 'bad'); return; }
  setStatus(el.calCheckStatus, '', '');
  renderCheck(Array.isArray(res.results) ? res.results : []);
}

function checkError(err) {
  if (err === 'no-key') return 'Add a key first';
  if (err === 'cap') return 'Monthly cap reached';
  if (err === 'disabled') return 'Turn the extension on in the popup first';
  return err || 'Could not score the posts';
}

function renderCheck(results) {
  el.calCheckResults.textContent = '';
  CAL.check.forEach((post, i) => {
    const r = results[i];
    const card = mk('div', 'cal-result');
    card.appendChild(mk('p', 'cal-text', post.text));
    const line = mk('div', 'cal-score');
    if (r && r.ok && Number.isFinite(Number(r.score))) {
      const s = Math.max(0, Math.min(100, Math.round(Number(r.score))));
      const dot = mk('span', 'dot');
      dot.style.background = scoreColor(s);
      dot.setAttribute('aria-hidden', 'true');
      line.append(dot, mk('b', '', String(s)), mk('span', 'band', bandFor(s).label));
      if (r.reason) line.appendChild(mk('span', 'reason', `— ${r.reason}`));
    } else {
      line.classList.add('muted');
      line.textContent = 'couldn’t score';
      if (r && r.error) line.title = String(r.error);
    }
    card.appendChild(line);
    el.calCheckResults.appendChild(card);
  });
  el.calCheckResults.hidden = false;
  el.calCheckNote.hidden = false;
}

// ---- Deep links: #calibrate (from the popup), #key, #threshold, #open ----

const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollToStep(step, flash) {
  step.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
  if (!flash) return;
  step.classList.remove('flash');
  void step.offsetWidth; // restart the animation when the same hash is opened twice
  step.classList.add('flash');
  step.addEventListener('animationend', () => step.classList.remove('flash'), { once: true });
}

function stepFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const step = id && document.getElementById(id);
  if (step && step.classList.contains('step')) scrollToStep(step, true);
}

// ---- Step 4: Firefox host permissions ----

async function checkHosts() {
  let has = true;
  try { has = await api.permissions.contains({ origins: ['https://x.com/*'] }); } catch { /* API missing: assume granted */ }
  el.firefoxBlock.hidden = has;
}

async function grantHosts() {
  let ok = false;
  try { ok = await api.permissions.request({ origins: SITE_ORIGINS }); } catch (e) { setStatus(el.hostStatus, e && e.message ? e.message : String(e), 'bad'); return; }
  if (ok) { setStatus(el.hostStatus, 'Access granted.', 'ok'); setTimeout(checkHosts, 600); }
  else setStatus(el.hostStatus, 'Not granted. The extension can’t read x.com without it.', 'bad');
}

// ---- init ----

async function init() {
  const stored = await api.storage.local.get(Object.keys(DEFAULTS));
  for (const k of Object.keys(DEFAULTS)) if (stored[k] !== undefined && stored[k] !== null) current[k] = stored[k];
  if (!PROVIDERS[current.provider]) current.provider = 'openai';
  if (!Array.isArray(current.calibration)) current.calibration = [];

  setCutoffUI(current.cutoff);
  loadPicks();
  renderCalibration();
  applyProvider(current.provider);
  checkHosts();

  for (const b of el.seg) {
    b.addEventListener('click', () => {
      const p = b.dataset.provider;
      if (p === current.provider) return;
      const cfg = PROVIDERS[p];
      // Model defaults follow the provider, as the popup does when the provider changes.
      save({ provider: p, scoreModel: cfg.scoreModel, rewriteModel: cfg.rewriteModel });
      applyProvider(p);
    });
  }

  el.reveal.addEventListener('click', () => {
    const show = el.apiKey.type === 'password';
    el.apiKey.type = show ? 'text' : 'password';
    el.reveal.classList.toggle('on', show);
    el.reveal.title = el.reveal.ariaLabel = show ? 'Hide key' : 'Show key';
  });

  let keyTimer;
  el.apiKey.addEventListener('input', () => {
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      const field = PROVIDERS[current.provider].keyField;
      const key = el.apiKey.value.trim();
      if (key === (current[field] || '')) return;
      save({ [field]: key });
      checkKey();
    }, 500);
  });

  el.baseUrl.addEventListener('change', commitBaseUrl);
  el.baseUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.baseUrl.blur(); });
  el.allowOrigin.addEventListener('click', async () => { if (await originCheck(current.baseUrl, true)) checkKey(); });

  const commitModel = () => {
    const id = el.customModel.value.trim();
    if (id === current.scoreModel && id === current.rewriteModel) return;
    save({ scoreModel: id, rewriteModel: id });
    checkKey();
  };
  el.customModel.addEventListener('change', commitModel);
  el.customModel.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.customModel.blur(); });

  el.calSkip.addEventListener('click', (e) => { e.preventDefault(); scrollToStep(el.thresholdStep, false); });
  el.calCheckBtn.addEventListener('click', runCheck);

  el.cutoff.addEventListener('input', () => setCutoffUI(Number(el.cutoff.value)));
  el.cutoff.addEventListener('change', () => save({ cutoff: Number(el.cutoff.value) }));

  el.grantHosts.addEventListener('click', grantHosts);
  el.openX.addEventListener('click', () => { api.storage.local.set({ onboarded: true }); });

  // Keep in step with the popup if both are open.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let providerChanged = false;
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in changes)) continue;
      const v = changes[k].newValue;
      if (v === undefined) continue;
      if (k === 'calibration') {
        current.calibration = Array.isArray(v) ? v : [];
        loadPicks();
        syncCalibrationUI();
        continue;
      }
      if (v === current[k]) continue;
      current[k] = v;
      if (k === 'cutoff') { if (document.activeElement !== el.cutoff) setCutoffUI(v); }
      else providerChanged = true;
    }
    if (providerChanged && !['INPUT'].includes(document.activeElement && document.activeElement.tagName)) applyProvider(current.provider);
  });

  window.addEventListener('hashchange', stepFromHash);
  stepFromHash();
}

init();
