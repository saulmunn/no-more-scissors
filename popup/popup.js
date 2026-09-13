'use strict';

const DEFAULTS = {
  provider: 'openai', apiKey: '', anthropicKey: '', compatibleKey: '', baseUrl: '',
  enabled: true, cutoff: 40, hideCutoff: 85, showScores: true, blurPending: true,
  scoreModel: 'gpt-5.4-nano', rewriteModel: 'gpt-5.4-mini',
  rewriteStrength: 5, customStyle: '', spendCap: 10,
};

const PROVIDERS = {
  openai: {
    keyField: 'apiKey', keyLabel: 'OpenAI API key', placeholder: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
    scoreModel: 'gpt-5.4-nano', rewriteModel: 'gpt-5.4-mini',
    models: [
      ['gpt-5.4-nano', 'gpt-5.4-nano · fastest, cheapest'],
      ['gpt-5.4-mini', 'gpt-5.4-mini · better writing'],
      ['gpt-5.4', 'gpt-5.4 · best'],
      ['gpt-5.6-luna', 'gpt-5.6-luna · cheap'],
      ['gpt-4.1-mini', 'gpt-4.1-mini · older'],
      ['gpt-4.1-nano', 'gpt-4.1-nano · older, cheapest'],
      ['gpt-5-mini', 'gpt-5-mini'],
      ['gpt-5-nano', 'gpt-5-nano'],
      ['gpt-4o-mini', 'gpt-4o-mini'],
      ['gpt-4o', 'gpt-4o'],
    ],
  },
  anthropic: {
    keyField: 'anthropicKey', keyLabel: 'Anthropic API key', placeholder: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    scoreModel: 'claude-haiku-4-5', rewriteModel: 'claude-opus-5',
    models: [
      ['claude-haiku-4-5', 'claude-haiku-4-5 · fastest, cheapest'],
      ['claude-sonnet-5', 'claude-sonnet-5 · balanced'],
      ['claude-opus-5', 'claude-opus-5 · best'],
      ['claude-opus-4-8', 'claude-opus-4-8'],
      ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ],
  },
  compatible: {
    keyField: 'compatibleKey', keyLabel: 'API key (optional)', placeholder: 'sk-… or empty for Ollama',
    keysUrl: null, scoreModel: '', rewriteModel: '', models: null,
  },
};

const STRENGTH_HINTS = {
  1: 'Only the hostile words change',
  2: 'Hostile words and exaggeration toned down',
  3: 'Contempt and sarcasm removed, voice kept',
  4: 'Restated as plain, matter-of-fact prose',
  5: 'Restated from scratch, bland and neutral',
};

const $ = (id) => document.getElementById(id);
const el = {
  enabled: $('enabled'), capBanner: $('capBanner'),
  providerRadios: [...document.querySelectorAll('input[name="provider"]')],
  baseUrlField: $('baseUrlField'), baseUrl: $('baseUrl'), baseUrlWarn: $('baseUrlWarn'),
  keyLabel: $('keyLabel'), apiKey: $('apiKey'), reveal: $('reveal'), keyStatus: $('keyStatus'),
  cutoff: $('cutoff'), cutoffValue: $('cutoffValue'), cutoffHint: $('cutoffHint'),
  hideCutoff: $('hideCutoff'), hideCutoffValue: $('hideCutoffValue'), hideCutoffHint: $('hideCutoffHint'),
  rewriteStrength: $('rewriteStrength'), strengthValue: $('strengthValue'), strengthHint: $('strengthHint'), customToggle: $('customToggle'), customStyle: $('customStyle'),
  showScores: $('showScores'), blurPending: $('blurPending'),
  scoreModel: $('scoreModel'), rewriteModel: $('rewriteModel'),
  scoreModelText: $('scoreModelText'), rewriteModelText: $('rewriteModelText'),
  scoreModelLabel: $('scoreModelLabel'), rewriteModelLabel: $('rewriteModelLabel'),
  customField: $('customField'), customModel: $('customModel'),
  spendCap: $('spendCap'), capNote: $('capNote'), monthLine: $('monthLine'), monthCost: $('monthCost'),
  statsLine: $('statsLine'), costLine: $('costLine'), lastError: $('lastError'), clearCache: $('clearCache'),
  setupGuide: $('setupGuide'), saved: $('saved'),
};

let current = { ...DEFAULTS };
let customTarget = null; // which select the "Custom…" box edits
// Models the user picked per provider in this popup session (seeded with the stored pair for the
// stored provider) so switching providers and back does not lose them.
const chosen = { openai: {}, anthropic: {}, compatible: {} };

const provider = () => PROVIDERS[current.provider] || PROVIDERS.openai;
const activeKey = () => current[provider().keyField] || '';
// Don't overwrite a field the user is typing in (used when storage changes underneath us).
const setVal = (input, v) => { if (document.activeElement !== input) input.value = v; };

function cutoffHint(v) {
  if (v <= 15) return 'Rewrites almost everything with any edge to it';
  if (v <= 35) return 'Rewrites snark and sarcasm, leaves earnest opinions alone';
  if (v <= 55) return 'Rewrites hostile or contemptuous posts';
  if (v <= 75) return 'Rewrites only insults, name-calling and rage bait';
  if (v <= 95) return 'Rewrites only slurs, threats and the very worst';
  return 'Rewrites nothing; scores only';
}
const hideHint = (v) => (v > 100 ? 'Nothing is collapsed' : 'Collapsed to one line with a Show anyway link');

function save(patch) {
  Object.assign(current, patch);
  chrome.storage.local.set(patch).then(flashSaved);
}

let savedTimer;
function flashSaved() {
  el.saved.textContent = 'Saved';
  el.saved.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.saved.classList.remove('show'), 1200);
}

function fmtMoney(usd) {
  return `$${(Number(usd) || 0).toFixed(2)}`;
}

/* ---------- provider + key ---------- */

function setKeyStatus(text, kind) {
  el.keyStatus.className = `sub status${kind ? ' ' + kind : ''}`;
  el.keyStatus.replaceChildren();
  if (text === 'none') {
    const p = provider();
    el.keyStatus.append('Paste a key to start. ');
    if (p.keysUrl) {
      const a = document.createElement('a');
      a.href = p.keysUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Get one';
      el.keyStatus.append(a, '.');
    }
  } else {
    el.keyStatus.textContent = text;
  }
}

let keyCheck = 0;
async function checkKey() {
  const p = current.provider, key = activeKey();
  const id = ++keyCheck;
  if (p === 'compatible') {
    if (!current.baseUrl) { setKeyStatus('Enter a base URL to connect', ''); return; }
  } else if (!key) { setKeyStatus('none', ''); return; }
  setKeyStatus('Checking…', '');
  const msg = { type: 'testKey', provider: p, apiKey: key };
  if (p === 'compatible') msg.baseUrl = current.baseUrl;
  const res = await chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e && e.message }));
  if (id !== keyCheck) return;
  if (res && res.ok) setKeyStatus(res.note || (key ? 'Key works' : 'Endpoint works'), 'ok');
  else setKeyStatus(res && res.error ? res.error : 'Could not verify key', 'bad');
}

function setUrlWarn(text) {
  el.baseUrlWarn.hidden = !text;
  el.baseUrlWarn.textContent = text || '';
}

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch { return null; }
}

async function checkUrlPermission(url) {
  const origin = originOf(url);
  if (!origin || !chrome.permissions || !chrome.permissions.contains) return;
  const ok = await chrome.permissions.contains({ origins: [origin + '/*'] }).catch(() => true);
  if (!ok) setUrlWarn(`No access to ${origin} yet — re-enter the URL to allow it`);
}

function setReveal(show) {
  el.apiKey.type = show ? 'text' : 'password';
  el.reveal.classList.toggle('on', show);
  el.reveal.title = el.reveal.ariaLabel = show ? 'Hide key' : 'Show key';
}

function renderProvider() {
  const p = provider();
  for (const r of el.providerRadios) r.checked = r.value === current.provider;
  el.keyLabel.textContent = p.keyLabel;
  el.apiKey.placeholder = p.placeholder;
  setVal(el.apiKey, activeKey());
  setReveal(false);
  el.baseUrlField.hidden = current.provider !== 'compatible';
  setVal(el.baseUrl, current.baseUrl);
  setUrlWarn('');
}

function switchProvider(id) {
  if (!PROVIDERS[id] || id === current.provider) return;
  const d = PROVIDERS[id], mine = chosen[id];
  save({
    provider: id,
    scoreModel: mine.scoreModel !== undefined ? mine.scoreModel : d.scoreModel,
    rewriteModel: mine.rewriteModel !== undefined ? mine.rewriteModel : d.rewriteModel,
  });
  renderProvider();
  renderModels();
  if (id === 'compatible') checkUrlPermission(current.baseUrl);
  checkKey();
}

/* ---------- thresholds ---------- */

function renderCutoffs() {
  el.cutoff.value = current.cutoff;
  el.cutoffValue.textContent = current.cutoff;
  el.cutoffHint.textContent = cutoffHint(current.cutoff);
  el.hideCutoff.value = current.hideCutoff;
  el.hideCutoffValue.textContent = current.hideCutoff > 100 ? 'Never' : current.hideCutoff;
  el.hideCutoffHint.textContent = hideHint(current.hideCutoff);
}

/* ---------- style ---------- */

function renderStyle() {
  const v = Math.max(1, Math.min(5, Math.round(Number(current.rewriteStrength) || 5)));
  el.rewriteStrength.value = v;
  el.strengthValue.textContent = v;
  el.strengthHint.textContent = STRENGTH_HINTS[v] || '';
  setVal(el.customStyle, current.customStyle);
  const open = !!current.customStyle || el.customStyle.dataset.open === '1';
  el.customStyle.hidden = !open;
  el.customToggle.hidden = open;
}

/* ---------- models ---------- */

function fillSelect(select, value, models) {
  select.replaceChildren();
  for (const [id, label] of models) select.append(new Option(label, id));
  select.append(new Option('Custom…', '__custom'));
  if (![...select.options].some((o) => o.value === value)) {
    select.append(new Option(`${value} (custom)`, value));
  }
  select.value = value;
}

function renderModels() {
  const p = provider();
  const plain = !p.models;
  el.scoreModel.hidden = plain;
  el.rewriteModel.hidden = plain;
  el.scoreModelText.hidden = !plain;
  el.rewriteModelText.hidden = !plain;
  el.scoreModelLabel.htmlFor = plain ? 'scoreModelText' : 'scoreModel';
  el.rewriteModelLabel.htmlFor = plain ? 'rewriteModelText' : 'rewriteModel';
  el.customField.hidden = true;
  customTarget = null;
  if (plain) {
    setVal(el.scoreModelText, current.scoreModel);
    setVal(el.rewriteModelText, current.rewriteModel);
  } else {
    fillSelect(el.scoreModel, current.scoreModel, p.models);
    fillSelect(el.rewriteModel, current.rewriteModel, p.models);
  }
}

function saveModel(key, value) {
  chosen[current.provider][key] = value;
  save({ [key]: value });
}

function bindModel(select, key) {
  select.addEventListener('change', () => {
    if (select.value === '__custom') {
      customTarget = key;
      el.customField.hidden = false;
      el.customModel.value = '';
      el.customModel.focus();
      return;
    }
    el.customField.hidden = true;
    saveModel(key, select.value);
  });
}

function bindModelText(input, key) {
  input.addEventListener('change', () => {
    const id = input.value.trim();
    input.value = id;
    if (id !== current[key]) saveModel(key, id);
  });
}

/* ---------- cap + stats ---------- */

function renderCap() {
  setVal(el.spendCap, current.spendCap);
  el.capNote.textContent = Number(el.spendCap.value) === 0 ? 'no cap' : '';
}

async function loadStats() {
  const res = await chrome.runtime.sendMessage({ type: 'getStats' }).catch(() => null);
  if (!res || !res.ok) { el.statsLine.textContent = ''; el.costLine.textContent = ''; el.monthCost.textContent = ''; return; }
  const stats = res.stats || {};
  const approx = res.costEstimated ? 'over ' : '≈ ';
  el.monthCost.textContent = approx + fmtMoney(res.costMonth);
  el.capBanner.hidden = !res.capReached;
  el.monthLine.classList.toggle('warn', !!res.capReached);
  const b = (n) => { const x = document.createElement('b'); x.textContent = (n || 0).toLocaleString(); return x; };
  el.statsLine.replaceChildren(b(stats.scored), ' scored · ', b(stats.rewritten), ' rewritten');
  el.costLine.textContent = `${approx}${fmtMoney(res.costTotal)} lifetime`;
  el.clearCache.hidden = !res.cacheSize;
  if (stats.lastError && Date.now() - (stats.lastErrorAt || 0) < 6 * 3600 * 1000) {
    el.lastError.hidden = false;
    el.lastError.textContent = `Last error: ${stats.lastError}`;
  } else {
    el.lastError.hidden = true;
  }
}

/* ---------- init ---------- */

function renderAll() {
  el.enabled.checked = current.enabled;
  renderProvider();
  renderCutoffs();
  renderStyle();
  el.showScores.checked = current.showScores;
  el.blurPending.checked = current.blurPending;
  renderModels();
  renderCap();
}

async function init() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  for (const k of Object.keys(DEFAULTS)) if (stored[k] !== undefined) current[k] = stored[k];
  if (!PROVIDERS[current.provider]) current.provider = 'openai';
  chosen[current.provider] = { scoreModel: current.scoreModel, rewriteModel: current.rewriteModel };
  // Repair an inconsistent pair (rewrite above collapse) once, so the sliders never disagree.
  if (current.cutoff > current.hideCutoff) save({ cutoff: current.hideCutoff });

  renderAll();
  setKeyStatus(activeKey() ? '' : 'none', '');
  checkKey();
  if (current.provider === 'compatible') checkUrlPermission(current.baseUrl);

  el.enabled.addEventListener('change', () => save({ enabled: el.enabled.checked }));

  for (const r of el.providerRadios) r.addEventListener('change', () => { if (r.checked) switchProvider(r.value); });

  el.reveal.addEventListener('click', () => setReveal(el.apiKey.type === 'password'));

  let keyTimer;
  el.apiKey.addEventListener('input', () => {
    clearTimeout(keyTimer);
    const field = provider().keyField;
    const key = el.apiKey.value.trim();
    keyTimer = setTimeout(() => {
      if (key === current[field]) return;
      save({ [field]: key });
      if (field === provider().keyField) checkKey();
    }, 500);
  });

  el.baseUrl.addEventListener('change', () => {
    const url = el.baseUrl.value.trim().replace(/\/+$/, '');
    el.baseUrl.value = url;
    setUrlWarn('');
    const origin = originOf(url);
    if (url && !origin) { setUrlWarn('Enter a full http(s) URL'); return; }
    if (url !== current.baseUrl) save({ baseUrl: url });
    if (!origin) { checkKey(); return; }
    // Must stay inside the change handler (user gesture) for Chrome to show the prompt.
    let req;
    try {
      req = chrome.permissions && chrome.permissions.request
        ? chrome.permissions.request({ origins: [origin + '/*'] })
        : Promise.resolve(true);
    } catch (e) { req = Promise.reject(e); }
    req.then((granted) => {
      if (!granted) setUrlWarn(`Access to ${origin} was denied — re-enter the URL to try again`);
      checkKey();
    }).catch((e) => {
      setUrlWarn(`Could not request access to ${origin}: ${e && e.message ? e.message : e}`);
      checkKey();
    });
  });

  el.cutoff.addEventListener('input', () => {
    const raw = Number(el.cutoff.value), max = Math.min(100, current.hideCutoff);
    const v = Math.min(raw, max);
    if (v !== raw) el.cutoff.value = v;
    el.cutoffValue.textContent = v;
    el.cutoffHint.textContent = raw > max ? `Can’t go above the collapse threshold (${max})` : cutoffHint(v);
  });
  el.cutoff.addEventListener('change', () => {
    const v = Math.min(Number(el.cutoff.value), 100, current.hideCutoff);
    el.cutoff.value = v;
    if (v !== current.cutoff) save({ cutoff: v });
    el.hideCutoffHint.textContent = hideHint(current.hideCutoff);
  });

  el.hideCutoff.addEventListener('input', () => {
    const raw = Number(el.hideCutoff.value), min = Math.max(50, current.cutoff);
    const v = Math.max(raw, min);
    if (v !== raw) el.hideCutoff.value = v;
    el.hideCutoffValue.textContent = v > 100 ? 'Never' : v;
    el.hideCutoffHint.textContent = raw < min ? `Can’t go below the rewrite threshold (${min})` : hideHint(v);
  });
  el.hideCutoff.addEventListener('change', () => {
    const v = Math.max(Number(el.hideCutoff.value), 50, current.cutoff);
    el.hideCutoff.value = v;
    if (v !== current.hideCutoff) save({ hideCutoff: v });
    el.cutoffHint.textContent = cutoffHint(current.cutoff);
  });

  el.rewriteStrength.addEventListener('input', () => {
    const v = Number(el.rewriteStrength.value);
    el.strengthValue.textContent = v;
    el.strengthHint.textContent = STRENGTH_HINTS[v] || '';
  });
  el.rewriteStrength.addEventListener('change', () => {
    const v = Number(el.rewriteStrength.value);
    if (v !== current.rewriteStrength) save({ rewriteStrength: v });
  });
  el.customToggle.addEventListener('click', () => {
    el.customStyle.dataset.open = '1';
    renderStyle();
    el.customStyle.focus();
  });
  el.customStyle.addEventListener('change', () => {
    const v = el.customStyle.value.trim();
    if (v !== current.customStyle) save({ customStyle: v });
  });

  el.showScores.addEventListener('change', () => save({ showScores: el.showScores.checked }));
  el.blurPending.addEventListener('change', () => save({ blurPending: el.blurPending.checked }));

  bindModel(el.scoreModel, 'scoreModel');
  bindModel(el.rewriteModel, 'rewriteModel');
  bindModelText(el.scoreModelText, 'scoreModel');
  bindModelText(el.rewriteModelText, 'rewriteModel');
  const commitCustom = () => {
    const id = el.customModel.value.trim();
    if (!id || !customTarget) return;
    const select = customTarget === 'scoreModel' ? el.scoreModel : el.rewriteModel;
    fillSelect(select, id, provider().models || []);
    saveModel(customTarget, id);
    el.customField.hidden = true;
  };
  el.customModel.addEventListener('change', commitCustom);
  el.customModel.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitCustom(); });

  el.spendCap.addEventListener('input', () => { el.capNote.textContent = Number(el.spendCap.value) === 0 ? 'no cap' : ''; });
  el.spendCap.addEventListener('change', () => {
    let v = Math.round(Number(el.spendCap.value));
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v !== current.spendCap) { save({ spendCap: v }); loadStats(); }
    el.spendCap.value = v;
    el.capNote.textContent = v === 0 ? 'no cap' : '';
  });

  el.clearCache.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' }).catch(() => {});
    flashSaved();
    loadStats();
  });

  el.setupGuide.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'openOnboarding' }).catch(() => {});
    window.close();
  });

  const calibrateBtn = document.getElementById('calibrate');
  chrome.storage.local.get('calibration').then(({ calibration }) => {
    if (Array.isArray(calibration) && calibration.length) calibrateBtn.textContent = 'Recalibrate';
  }).catch(() => {});
  calibrateBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'openOnboarding', hash: 'calibrate' }).catch(() => {});
    window.close();
  });

  // Reflect changes made elsewhere (onboarding page, another popup) without clobbering live typing.
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let touched = false;
      for (const [k, c] of Object.entries(changes)) {
        if (!(k in DEFAULTS)) continue;
        const v = c.newValue === undefined ? DEFAULTS[k] : c.newValue;
        if (v === current[k]) continue;
        current[k] = v;
        touched = true;
      }
      if (touched) renderAll();
    });
  }

  loadStats();
  setInterval(loadStats, 3000);
}

init();
