// composer.js — live score on the compose box and reply-to-original behaviour (see docs/architecture.md)
// Loads after common.js and content.js; uses window.NMS helpers plus the optional NMS.core.forceOriginal.
(() => {
  'use strict';
  const NMS = window.NMS;
  if (!NMS || NMS.composer) return;

  const SEL_TA = '[data-testid="tweetTextarea_0"]';
  const SEL_BTN = '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';
  const SEL_CELL = '[data-testid="cellInnerDiv"]';
  const MIN_CHARS = 8;
  const DEBOUNCE_MS = 900;
  const POLL_MS = 500;          // Draft.js does not always emit input events; poll while focused
  const CACHE_MAX = 60;
  const REPLY_NOTE = "You're replying to the original wording, not the calmer rewrite";
  const REPLY_RETRY_AT = [0, 300, 800, 1500]; // content.js may render the parent post after the dialog opens

  const composers = new Map();  // textarea -> state
  const scoreCache = new Map(); // text -> { score, reason }: the same text is never sent twice
  const inflight = new Map();   // text -> pending promise (shared between composers)
  const testLog = (...a) => { if (window.__nmsTest) console.log('[nms composer]', ...a); };

  // ---------- draft text ----------

  function draftText(ta) {
    const blocks = ta.querySelectorAll('[data-block="true"]');
    const raw = blocks.length ? [...blocks].map((b) => b.textContent).join('\n') : ta.textContent;
    return raw.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  // ---------- badge placement ----------

  // The composer root is the first ancestor of the textarea that also contains its Post button.
  function postButton(ta) {
    for (let root = ta.parentElement; root && root !== document.documentElement; root = root.parentElement) {
      const btn = root.querySelector(SEL_BTN);
      if (btn) return btn;
    }
    return null;
  }

  // Verified 2026-09-13: [data-testid="toolBar"] > [nav, div(flex row, align-items center) > div(flex column) > button].
  // Climb the column-only wrappers around the button and insert into that row, right before the button's slot,
  // so the badge sits immediately left of Post and is vertically centred by the row itself.
  function mount(state) {
    if (state.wrap && state.wrap.isConnected) return true;
    const btn = postButton(state.ta);
    if (!btn) return false;
    let slot = btn;
    while (slot.parentElement && slot.parentElement.dataset.testid !== 'toolBar'
      && getComputedStyle(slot.parentElement).flexDirection === 'column') slot = slot.parentElement;
    const row = slot.parentElement;
    if (!row) return false;
    if (!state.wrap) {
      state.wrap = NMS.el('span', 'nms-compose-badge nms-ui');
      state.wrap.setAttribute('aria-live', 'polite');
    }
    NMS.copyTextStyle(state.ta, state.wrap, ['font-family', 'color']);
    row.insertBefore(state.wrap, slot);
    return true;
  }

  function setOff(state, off) { if (state.wrap) state.wrap.classList.toggle('nms-off', off); }

  // Nothing is shown while a score is pending: the badge simply appears when it's ready.
  function showPending(state) {
    if (!mount(state)) return;
    if (state.wrap.dataset.state !== 'pending') {
      state.wrap.replaceChildren();
      state.wrap.title = '';
      state.wrap.dataset.state = 'pending';
    }
    setOff(state, true);
  }

  function showScore(state, text, r) {
    if (!mount(state)) return;
    if (state.wrap.dataset.state !== 'scored' || state.shownText !== text) {
      const badge = NMS.badge(r.score, r.reason);
      const reason = NMS.el('span', 'nms-compose-reason nms-ui', r.reason || NMS.scoreLabel(r.score));
      reason.title = badge.title;
      state.wrap.replaceChildren(badge, reason);
      state.wrap.title = '';
      state.wrap.dataset.state = 'scored';
      state.shownText = text;
    }
    setOff(state, false);
  }

  function hide(state) {
    if (!state.wrap) return;
    state.wrap.dataset.state = 'off';
    setOff(state, true);
  }

  // ---------- scoring ----------

  function remember(text, r) {
    scoreCache.set(text, r);
    while (scoreCache.size > CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value);
  }

  function update(state) {
    if (!NMS.alive || !state.ta.isConnected) return;
    const text = draftText(state.ta);
    if (text === state.text) {
      // Unchanged draft, but X may have re-rendered the toolbar underneath us: put the badge back.
      if (state.wrap && !state.wrap.isConnected && state.wrap.dataset.state !== 'off') mount(state);
      return;
    }
    state.text = text;
    clearTimeout(state.timer);
    if (!NMS.settings.enabled || text.length < MIN_CHARS) { hide(state); return; }
    const cached = scoreCache.get(text);
    if (cached) { showScore(state, text, cached); return; }
    showPending(state);
    state.timer = setTimeout(() => score(state, text), DEBOUNCE_MS);
  }

  async function score(state, text) {
    if (text !== state.text || !NMS.settings.enabled) return;
    let p = inflight.get(text);
    if (!p) {
      p = NMS.bg({ type: 'score', text }).finally(() => inflight.delete(text));
      inflight.set(text, p);
    }
    const res = await p;
    if (res && res.ok && typeof res.score === 'number') remember(text, { score: res.score, reason: res.reason || '' });
    if (text !== state.text || !state.ta.isConnected) return; // stale: the draft moved on
    if (!res || !res.ok || !NMS.settings.enabled) { hide(state); return; } // 'no-key', 'cap', disabled: show nothing
    showScore(state, text, scoreCache.get(text));
  }

  // ---------- replying shows the original wording ----------

  // Reply modal: the parent post is rendered inside the dialog. Inline reply on a post page (verified 2026-09-13):
  // X renders the reply box inside the focal post's own cellInnerDiv, so that cell is the scope. Should X ever give
  // the box its own cell, fall back to the cell(s) immediately preceding it, up to the first one holding an article.
  function replyScopes(ta) {
    const dialog = ta.closest('[role="dialog"]');
    if (dialog) return [dialog];
    if (!/\/status\/\d+/.test(location.pathname)) return [];
    const cell = ta.closest(SEL_CELL);
    if (!cell) return [];
    if (cell.querySelector('article')) return [cell];
    const scopes = [];
    for (let prev = cell.previousElementSibling, i = 0; prev && i < 3; prev = prev.previousElementSibling, i++) {
      scopes.push(prev);
      if (prev.querySelector('article')) break;
    }
    return scopes;
  }

  function replyToOriginal(state) {
    for (const t of state.replyTimers) clearTimeout(t);
    state.replyTimers = REPLY_RETRY_AT.map((ms) => setTimeout(() => {
      if (!state.ta.isConnected) return;
      const core = NMS.core;
      const scopes = replyScopes(state.ta);
      if (ms === 0) testLog('reply scope', scopes, core && typeof core.forceOriginal === 'function' ? 'forceOriginal present' : 'forceOriginal missing');
      if (!core || typeof core.forceOriginal !== 'function') return;
      for (const scope of scopes) {
        try { core.forceOriginal(scope, REPLY_NOTE); } catch (e) { console.error('[nms composer]', e); }
      }
    }, ms));
  }

  // ---------- lifecycle ----------

  function onFocus(state) {
    // The poll also ends itself when focus is gone, in case the focusout event never reaches us.
    if (!state.poll) state.poll = setInterval(() => (state.ta.contains(document.activeElement) ? update(state) : onBlur(state)), POLL_MS);
    update(state);
    replyToOriginal(state);
  }

  function onBlur(state) {
    clearInterval(state.poll);
    state.poll = 0;
    update(state);
  }

  function attach(ta) {
    let state = composers.get(ta);
    if (state) return state;
    state = { ta, wrap: null, text: null, shownText: null, timer: 0, poll: 0, replyTimers: [], mo: null };
    composers.set(ta, state);
    ta.addEventListener('input', () => update(state));
    state.mo = new MutationObserver(() => update(state));
    state.mo.observe(ta, { childList: true, characterData: true, subtree: true });
    update(state);
    if (ta.contains(document.activeElement)) onFocus(state);
    return state;
  }

  function detach(state) {
    clearTimeout(state.timer);
    clearInterval(state.poll);
    for (const t of state.replyTimers) clearTimeout(t);
    if (state.mo) state.mo.disconnect();
    if (state.wrap) state.wrap.remove();
    composers.delete(state.ta);
  }

  const scan = NMS.debounce(() => {
    if (!NMS.alive) return;
    for (const ta of document.querySelectorAll(SEL_TA)) attach(ta);
    for (const state of [...composers.values()]) {
      if (!state.ta.isConnected) { detach(state); continue; }
      // X's root handlers can swallow focus events (seen on the inline reply box), so reconcile with
      // the real focus on every scan as well.
      const focused = state.ta.contains(document.activeElement);
      if (focused && !state.poll) onFocus(state);
      else if (!focused && state.poll) onBlur(state);
    }
  }, 80);

  // Capture phase: focus events must be seen before X's React root can stop their propagation.
  const taOf = (e) => (e.target instanceof Element ? e.target.closest(SEL_TA) : null);
  document.addEventListener('focusin', (e) => { const ta = taOf(e); if (ta) onFocus(attach(ta)); }, true);
  document.addEventListener('focusout', (e) => { const ta = taOf(e); const s = ta && composers.get(ta); if (s) onBlur(s); }, true);

  NMS.onSettings((changed) => {
    if ('enabled' in changed && !changed.enabled) {
      for (const s of composers.values()) { clearTimeout(s.timer); hide(s); }
      return;
    }
    if ('enabled' in changed || changed.credentials) {
      for (const s of composers.values()) { s.text = null; update(s); }
    }
  });

  NMS.ready.then(() => {
    new MutationObserver((muts) => {
      for (const m of muts) if (m.addedNodes.length || m.removedNodes.length) { scan(); return; }
    }).observe(document.body, { childList: true, subtree: true });
    scan();
  });

  NMS.composer = { composers, scoreCache, draftText, replyScopes, update, scan, onFocus, onBlur };
})();
