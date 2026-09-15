// No More Scissors — timeline core for x.com / twitter.com (contract: docs/architecture.md).
//
// Every `[data-testid="tweetText"]` is a *unit*: the post's own text and the quoted post's text
// are scored, badged and rewritten independently. Units are batched to the background nearest-to-
// the-viewport first. X's DOM is never rewritten: we add classes and insert siblings, nothing more.
(() => {
  'use strict';
  if (window.__nmsCoreLoaded) return;
  window.__nmsCoreLoaded = true;
  const NMS = window.NMS;
  if (!NMS) return;

  const SEL_POST = 'article[data-testid="tweet"]';
  const SEL_TEXT = '[data-testid="tweetText"]';
  const SEL_QUOTE = 'div[role="link"]';
  const SEL_HEADER = '[data-testid="User-Name"]';
  const SEL_ACTIONS = 'div[role="group"]';
  const SEL_MEDIA = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"], div[role="link"]';
  const SEL_OURS = '.nms-rewrite, .nms-show-more, .nms-collapsed, .nms-note';
  const SEL_SHOW_MORE = '[data-testid="tweet-text-show-more-link"]';
  const MIN_CHARS = 8;
  const BATCH = 8;
  const QUIET_MS = 100;
  const BLUR_MAX_MS = 4000;

  const S = NMS.settings;           // live settings object owned by common.js
  const notes = new Map();          // post id -> full text of a long post, from content/page-hook.js
  const NOTES_MAX = 3000;
  const units = new Map();          // textDiv -> state
  const memo = new Map();           // text -> complete result for the current generation
  let gen = 0;                      // bumped on every settings change; older responses are ignored
  let stopped = null;               // null | 'no-key' | 'cap' | 'dead'
  let queue = [];                   // states waiting for the next flush
  let flushTimer = 0;
  const batchLog = [];              // test aid: what was sent, in what order

  // ---------- text helpers ----------

  const normText = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

  // Anchors of the original post, keyed by their visible text, so the rewrite can reuse them.
  function anchorMap(originalDiv) {
    const hrefs = new Map();
    for (const a of originalDiv.querySelectorAll('a[href]')) {
      const t = a.textContent.trim();
      if (t && !hrefs.has(t)) hrefs.set(t, a.href);
    }
    return hrefs;
  }

  // One whitespace-free token → text node, or lead + <a> + trail when it is a mention/hashtag/URL.
  function linkToken(part, hrefs) {
    const m = part.match(/^([([“"']*)(.*?)([)\]”"'.,!?:;…]*)$/s);
    const lead = m ? m[1] : '';
    const core = m ? m[2] : part;
    const trail = m ? m[3] : '';
    let href = hrefs.get(core) || hrefs.get(part) || null;
    if (!href) {
      if (/^@\w{1,15}$/.test(core)) href = `${location.origin}/${core.slice(1)}`;
      else if (/^#[\p{L}\p{N}_]+$/u.test(core)) href = `${location.origin}/hashtag/${encodeURIComponent(core.slice(1))}`;
      // Bare URLs that the original post did not carry are left as plain text: a rewrite must never
      // introduce a clickable link the author never posted.
    }
    if (!href) return document.createTextNode(part);
    const frag = document.createDocumentFragment();
    if (lead) frag.appendChild(document.createTextNode(lead));
    const a = document.createElement('a');
    a.href = href;
    a.textContent = core;
    if (/^https?:/.test(href) && !href.startsWith(location.origin)) a.target = '_blank';
    a.rel = 'noopener';
    a.addEventListener('click', (e) => e.stopPropagation()); // don't also open the post
    frag.appendChild(a);
    if (trail) frag.appendChild(document.createTextNode(trail));
    return frag;
  }

  // The rewrite as DOM: whitespace kept, every token run through linkToken so mentions, hashtags
  // and URLs are links again.
  function renderRewrite(rewrite, originalDiv) {
    const hrefs = anchorMap(originalDiv);
    const frag = document.createDocumentFragment();
    for (const s of String(rewrite).match(/\s+|\S+/g) || []) {
      frag.appendChild(/^\s+$/.test(s) ? document.createTextNode(s) : linkToken(s, hrefs));
    }
    return frag;
  }

  // ---------- DOM anchors ----------

  // The quoted-post container this node sits in (null for the post's own content).
  function quoteOf(node, article) {
    const q = node.closest(SEL_QUOTE);
    return q && q !== article && article.contains(q) ? q : null;
  }

  // Where the header badge goes and which X element to copy its look from. On the timeline the
  // header holds "@handle · 4h" with a <time>: the badge joins that row. On a post page the focal
  // post has no <time> in its name block (the date sits under the text), so the badge follows the
  // "@handle" span in its own row instead. Wrapper divs there carry no font (computed: Times), so
  // the style source must be the span, never the row.
  function headerSlot(state) {
    const header = state.quoted
      ? state.scope.querySelector(SEL_HEADER)
      : [...state.article.querySelectorAll(SEL_HEADER)].find((h) => !quoteOf(h, state.article));
    if (!header) return null;
    const time = header.querySelector('time');
    if (time) {
      const link = time.closest('a') || time;
      return { slot: link.parentElement || header, style: time };
    }
    const handle = [...header.querySelectorAll('span')].find((el) => /^@\w{1,15}$/.test(el.textContent.trim()));
    if (handle) {
      let row = handle;
      while (row.parentElement && row.parentElement !== header) row = row.parentElement;
      return { slot: row, style: handle };
    }
    return { slot: header.lastElementChild || header, style: header.querySelector('span') };
  }

  // Media / quote / card wrappers between the text and the action bar of the post's own column.
  function mediaBlocks(state) {
    const { article, textDiv } = state;
    const groups = [...article.querySelectorAll(SEL_ACTIONS)].filter((g) => !quoteOf(g, article));
    const actions = groups[groups.length - 1];
    if (!actions) return [];
    let col = actions.parentElement;
    while (col && col !== article && !col.contains(textDiv)) col = col.parentElement;
    if (!col) return [];
    const childOf = (el) => { while (el && el.parentElement !== col) el = el.parentElement; return el; };
    const textWrap = childOf(textDiv), actionsWrap = childOf(actions);
    if (!textWrap || !actionsWrap || textWrap === actionsWrap) return [];
    const out = [];
    for (let el = textWrap.nextElementSibling; el && el !== actionsWrap; el = el.nextElementSibling) {
      if (el.matches(SEL_MEDIA) || el.querySelector(SEL_MEDIA)) out.push(el);
    }
    return out;
  }

  // A text link in the style of X's "Show more". No href: nothing to navigate, nothing to bubble.
  function makeLink(label, onActivate) {
    const a = NMS.el('a', 'nms-link nms-ui', label);
    a.setAttribute('role', 'button');
    a.tabIndex = 0;
    const fire = (e) => { e.preventDefault(); e.stopPropagation(); onActivate(); };
    a.addEventListener('click', fire);
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
    return a;
  }

  function secondaryStyle(state, el, props = ['font-family', 'font-size', 'line-height', 'color']) {
    const h = headerSlot(state);
    if (h && h.style) { NMS.copyTextStyle(h.style, el, props); return; }
    NMS.copyTextStyle(state.textDiv, el, props);
    el.style.opacity = '.6';
  }

  // Keep our siblings in a fixed order right after the text element.
  function place(state) {
    let prev = state.textDiv;
    for (const el of [state.rewriteDiv, state.rewriteMoreEl, state.collapseRow, state.noteEl]) {
      if (!el) continue;
      if (el.parentNode !== prev.parentNode || el.previousElementSibling !== prev) prev.insertAdjacentElement('afterend', el);
      prev = el;
    }
  }

  // ---------- units ----------

  function textKey(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function addUnit(textDiv, article, quote) {
    const scope = quote || article;
    for (const stale of textDiv.parentElement ? textDiv.parentElement.querySelectorAll(`:scope > :is(${SEL_OURS})`) : []) stale.remove();
    const text = NMS.extractText(textDiv);
    const state = {
      textDiv, article, scope, quoted: !!quote, text, revision: 0,
      lang: textDiv.getAttribute('lang') || '',
      // Quoted posts carry no /status/ link, so key their author history by the quoted text instead
      // of misattributing the quoting post's id.
      id: quote ? (NMS.postId(quote) || 'q' + textKey(text)) : NMS.postId(article),
      author: NMS.authorOf(scope),
      // Long posts arrive cut off (~275 chars, mid-sentence) with X's "Show more" button right after the text.
      showMore: textDiv.parentElement ? textDiv.parentElement.querySelector(`:scope > ${SEL_SHOW_MORE}`) : null,
      truncated: false, full: false, rewriteExpanded: false, previewLength: previewLength(text),
      skipped: text.length < MIN_CHARS,
      result: null, retried: false, forced: false, forcedOriginal: false, noteText: '',
      swapped: false, collapsed: false, showingOriginal: false,
      badgeEl: null, badgeKey: '', rewriteDiv: null, rewriteText: null, rewriteMoreEl: null, toggleWrap: null, toggleLink: null,
      collapseRow: null, noteEl: null, hiddenBlocks: [], blurTimer: 0, pending: false, top: 0,
    };
    if (state.showMore) applyFullText(state);
    units.set(textDiv, state);
    if (state.skipped) return;
    textDiv.classList.add('nms-unit');
    const cached = memo.get(state.text);
    if (cached) render(state, cached); else enqueue(state);
  }

  // A cut-off post is scored and rewritten on its full text when the page hook has seen it in X's
  // own GraphQL responses; otherwise it stays truncated and the rewrite is told to stop where X did.
  function applyFullText(state) {
    const fullText = !state.quoted && state.id ? notes.get(state.id) : null;
    if (fullText && fullText.length > state.text.length) {
      state.text = fullText;
      state.full = true;
      state.truncated = false;
    } else {
      state.truncated = true;
    }
  }

  // X expands posts in place, often keeping the same tweetText element. Re-read its original
  // content and Show more control, and invalidate any response requested for the previous text.
  function syncUnit(state) {
    const domText = NMS.extractText(state.textDiv);
    const showMore = state.textDiv.parentElement?.querySelector(`:scope > ${SEL_SHOW_MORE}`) || null;
    const previousText = state.text;
    const previousTruncated = state.truncated;
    const previousFull = state.full;
    const previousPreviewLength = state.previewLength;
    const showMoreChanged = state.showMore !== showMore;
    if (showMoreChanged && state.showMore) state.showMore.classList.remove('nms-hidden');
    state.showMore = showMore;
    state.previewLength = previewLength(domText);
    state.text = domText;
    state.full = false;
    state.truncated = false;
    if (showMore) applyFullText(state);
    if (state.text === previousText && state.truncated === previousTruncated) {
      if (showMoreChanged || state.full !== previousFull || state.previewLength !== previousPreviewLength) applyVisibility(state);
      return;
    }
    state.revision++;
    // Remove the obsolete overlay immediately so it cannot hide an expanded original while waiting.
    teardownUnit(state);
    state.badgeEl = state.rewriteDiv = state.rewriteMoreEl = state.toggleWrap = state.toggleLink = state.collapseRow = state.noteEl = null;
    state.badgeKey = '';
    state.rewriteText = null;
    state.swapped = state.collapsed = false;
    state.result = null;
    state.retried = false;
    state.skipped = state.text.length < MIN_CHARS;
    if (state.skipped) return;
    state.textDiv.classList.add('nms-unit');
    const cached = memo.get(state.text);
    if (cached) render(state, cached); else enqueue(state);
  }

  // Full text can also arrive after an initial preview was already scored.
  function upgradeTruncated() {
    for (const st of units.values()) {
      if (st.showMore && !st.full && !st.quoted && st.id && notes.has(st.id) && st.textDiv.isConnected) syncUnit(st);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.type !== 'nms-notes' || !e.data.notes || typeof e.data.notes !== 'object') return;
    let added = false;
    for (const [id, text] of Object.entries(e.data.notes)) {
      if (!/^\d{5,25}$/.test(id) || typeof text !== 'string' || !text.trim()) continue;
      if (notes.has(id)) continue;
      notes.set(id, text);
      added = true;
    }
    while (notes.size > NOTES_MAX) notes.delete(notes.keys().next().value);
    if (added) upgradeTruncated();
  });

  window.postMessage({ type: 'nms-notes-ready' }, location.origin);

  function collectUnits(article) {
    let ownSeen = false;
    for (const textDiv of article.querySelectorAll(SEL_TEXT)) {
      const quote = quoteOf(textDiv, article);
      if (units.has(textDiv)) { syncUnit(units.get(textDiv)); if (!quote) ownSeen = true; continue; }
      if (!quote) { if (ownSeen) continue; ownSeen = true; }
      addUnit(textDiv, article, quote);
    }
  }

  function unblur(state) {
    if (state.blurTimer) { clearTimeout(state.blurTimer); state.blurTimer = 0; }
    state.pending = false;
    state.textDiv.classList.remove('nms-pending');
  }

  function teardownUnit(state) {
    unblur(state);
    for (const el of [state.rewriteDiv, state.rewriteMoreEl, state.toggleWrap, state.collapseRow, state.noteEl, state.badgeEl]) if (el) el.remove();
    for (const b of state.hiddenBlocks) b.classList.remove('nms-hidden');
    state.hiddenBlocks = [];
    state.textDiv.classList.remove('nms-hidden', 'nms-pending', 'nms-unit');
    if (state.showMore) state.showMore.classList.remove('nms-hidden');
  }

  function prune() {
    let changed = false;
    for (const [textDiv, st] of units) {
      if (textDiv.isConnected) continue;
      unblur(st);
      for (const b of st.hiddenBlocks) b.classList.remove('nms-hidden');
      units.delete(textDiv);
      changed = true;
    }
    if (changed) schedulePageCounts();
  }

  // ---------- batching ----------

  function enqueue(state) {
    if (stopped || !S.enabled || !NMS.alive) return;
    if (!queue.includes(state)) queue.push(state);
    if (!state.result && S.blurPending && !state.pending) {
      state.pending = true;
      state.textDiv.classList.add('nms-pending');
      state.blurTimer = setTimeout(() => unblur(state), BLUR_MAX_MS);
    }
    clearTimeout(flushTimer);
    // Posts on screen and full batches go out as soon as the current scan loop finishes (so the
    // batch is still sorted); everything else waits for a moment of quiet.
    const urgent = queue.length >= BATCH || inViewport(state.textDiv.getBoundingClientRect());
    flushTimer = setTimeout(flush, urgent ? 0 : QUIET_MS);
  }

  function inViewport(rect) {
    const H = window.innerHeight || 800;
    return !!(rect.width || rect.height) && rect.bottom >= 0 && rect.top <= H;
  }

  // Visible units first (closest to the viewport centre), then the ones just below, then above.
  function distanceKey(rect) {
    const H = window.innerHeight || 800, c = H / 2;
    if (!rect.width && !rect.height) return 1e9;   // not laid out yet (X measures cells offscreen): last
    if (rect.bottom >= 0 && rect.top <= H) return Math.min(Math.abs(rect.top - c), H - 1);
    if (rect.top > H) return H + (rect.top - H);
    return H + (-rect.bottom) * 2;
  }

  function flush() {
    clearTimeout(flushTimer); flushTimer = 0;
    const ready = [];
    for (const st of queue) {
      if (!st.textDiv.isConnected || units.get(st.textDiv) !== st) continue;
      const box = st.textDiv.getClientRects().length ? st.textDiv : st.scope;
      const rect = box.getBoundingClientRect();
      st.top = Math.round(rect.top);
      ready.push({ st, key: distanceKey(rect), visible: inViewport(rect) });
    }
    queue = [];
    ready.sort((a, b) => a.key - b.key);
    // Posts on screen go out one per request so the first screen fills as fast as possible;
    // everything below the fold is batched and arrives while you scroll.
    for (const r of ready) if (r.visible) send([r.st]);
    const rest = ready.filter((r) => !r.visible);
    for (let i = 0; i < rest.length; i += BATCH) send(rest.slice(i, i + BATCH).map((r) => r.st));
  }

  async function send(states) {
    const g = gen;
    const revisions = states.map((st) => st.revision);
    const items = states.map((st) => {
      const it = { id: st.id, text: st.text, lang: st.lang, author: st.author };
      if (st.forced) it.force = true;
      if (st.truncated) it.truncated = true;
      return it;
    });
    batchLog.push({ gen: g, items: states.map((st) => ({ top: st.top, quoted: st.quoted, forced: st.forced, text: st.text.slice(0, 40) })) });
    const res = await NMS.bg({ type: 'analyze', items });
    if (g !== gen) return;
    if (!NMS.alive) { die(); return; }
    if (!res || !res.ok) {
      states.forEach((st, i) => { if (st.revision === revisions[i] && units.get(st.textDiv) === st) applyError(st, (res && res.error) || 'No response'); });
      schedulePageCounts();
      return;
    }
    const results = Array.isArray(res.results) ? res.results : [];
    states.forEach((st, i) => {
      const r = results[i];
      if (st.revision !== revisions[i]) return;
      if (!st.textDiv.isConnected || units.get(st.textDiv) !== st) { if (r && r.ok && !st.forced && !st.retried) memo.set(st.text, r); return; }
      if (!r) applyError(st, 'No result');
      else if (!r.ok) applyError(st, r.error || 'Unknown error');
      else render(st, r);
    });
    schedulePageCounts();
  }

  function die() {
    stopped = 'dead';
    queue = [];
    clearTimeout(flushTimer);
    for (const st of units.values()) unblur(st);
    observer.disconnect();
  }

  function halt(reason) {
    if (stopped) return;
    stopped = reason;
    queue = [];
    clearTimeout(flushTimer);
    for (const st of units.values()) unblur(st);
  }

  function applyError(state, error) {
    unblur(state);
    if (error === 'no-key') { halt('no-key'); return; }
    if (error === 'cap') { halt('cap'); setBadge(state, errorBadge('Monthly spend cap reached')); return; }
    if (error === 'disabled') return;
    setBadge(state, errorBadge(error));
  }

  // ---------- rendering ----------

  function errorBadge(msg) {
    if (!S.showScores) return null;
    const b = NMS.el('span', 'nms-badge nms-err nms-ui');
    b.appendChild(NMS.el('span', 'nms-sep', '·'));
    b.appendChild(NMS.el('span', 'nms-num', '!'));
    b.title = `No More Scissors: ${msg}`;
    return b;
  }

  function setBadge(state, el) {
    if (state.badgeEl && !state.badgeEl.isConnected) { state.badgeEl = null; state.badgeKey = ''; }
    if (!el) { if (state.badgeEl) state.badgeEl.remove(); state.badgeEl = null; state.badgeKey = ''; return; }
    if (state.badgeEl && state.badgeKey === el.title) return;
    const h = headerSlot(state);
    if (!h) return;
    NMS.copyTextStyle(h.style || h.slot, el, ['font-family', 'font-size', 'line-height', 'font-weight', 'color']);
    for (const old of h.slot.querySelectorAll(':scope > .nms-badge')) if (old !== state.badgeEl) old.remove();
    if (state.badgeEl) state.badgeEl.replaceWith(el); else h.slot.appendChild(el);
    state.badgeEl = el;
    state.badgeKey = el.title;
    placeToggle(state);
  }

  // The "Show original" toggle sits in the header right after the score: "@handle · 4h · ●42 · Show original".
  function placeToggle(state) {
    const wrap = state.toggleWrap;
    if (!wrap) return;
    const h = headerSlot(state);
    if (!h) return;
    const anchor = state.badgeEl && state.badgeEl.isConnected ? state.badgeEl : null;
    if (anchor) { if (wrap.previousElementSibling !== anchor || wrap.parentNode !== anchor.parentNode) anchor.insertAdjacentElement('afterend', wrap); }
    else if (wrap.parentNode !== h.slot) h.slot.appendChild(wrap);
    NMS.copyTextStyle(h.style || h.slot, wrap, ['font-family', 'font-size', 'line-height', 'font-weight', 'color']);
  }

  function setCollapsed(state, on, result) {
    if (on) {
      state.collapsed = true;
      state.textDiv.classList.add('nms-hidden');
      if (!state.quoted) {
        for (const b of mediaBlocks(state)) if (!state.hiddenBlocks.includes(b)) { b.classList.add('nms-hidden'); state.hiddenBlocks.push(b); }
      }
      const row = state.collapseRow && state.collapseRow.isConnected ? state.collapseRow : NMS.el('div', 'nms-collapsed nms-ui');
      row.replaceChildren();
      secondaryStyle(state, row);
      row.appendChild(NMS.el('span', 'nms-collapsed-text', `Hidden · ${result.score} · ${result.reason || NMS.scoreLabel(result.score)}`));
      const link = makeLink('Show anyway', () => showAnyway(state, link));
      row.appendChild(link);
      state.collapseRow = row;
    } else {
      if (state.collapseRow) { state.collapseRow.remove(); state.collapseRow = null; }
      for (const b of state.hiddenBlocks) b.classList.remove('nms-hidden');
      state.hiddenBlocks = [];
      state.collapsed = false;
      state.textDiv.classList.remove('nms-hidden');
    }
    place(state);
  }

  function showAnyway(state, link) {
    if (state.forced) return;
    state.forced = true;
    state.retried = false;
    link.classList.add('nms-busy');
    if (stopped || !S.enabled) { if (state.result) render(state, state.result); return; }
    enqueue(state);
  }

  function setSwap(state, on) {
    if (on) {
      if (!state.rewriteDiv || !state.rewriteDiv.isConnected) {
        state.rewriteDiv = makeRewriteDiv(state.textDiv);
        state.rewriteText = null;
      }
      if (!state.toggleWrap || !state.toggleWrap.isConnected) {
        const wrap = NMS.el('span', 'nms-toggle nms-ui');
        wrap.appendChild(NMS.el('span', 'nms-sep', '·'));
        state.toggleLink = makeLink('Show original', () => { state.showingOriginal = !state.showingOriginal; applyVisibility(state); });
        state.toggleLink.classList.add('nms-head-link');
        wrap.appendChild(state.toggleLink);
        state.toggleWrap = wrap;
      }
      placeToggle(state);
      if (!state.swapped) state.showingOriginal = state.showingOriginal || !!state.forcedOriginal;
      state.swapped = true;
    } else {
      if (state.rewriteDiv) { state.rewriteDiv.remove(); state.rewriteDiv = null; state.rewriteText = null; }
      if (state.rewriteMoreEl) { state.rewriteMoreEl.remove(); state.rewriteMoreEl = null; }
      if (state.toggleWrap) { state.toggleWrap.remove(); state.toggleWrap = null; state.toggleLink = null; }
      if (state.showMore) state.showMore.classList.remove('nms-hidden');
      state.swapped = false;
      state.showingOriginal = false;
    }
    place(state);
    applyVisibility(state);
  }

  // Match the amount X shows in its original preview, excluding its trailing ellipsis.
  function previewLength(text) {
    return Array.from(text.replace(/(?:…|\.{3})\s*$/u, '').trimEnd()).length;
  }

  function updateRewrite(state) {
    const rewrite = state.result.rewrite;
    const chars = Array.from(rewrite);
    const shortened = state.full && state.showMore && !state.rewriteExpanded && chars.length > state.previewLength;
    const visibleText = shortened ? chars.slice(0, state.previewLength).join('').trimEnd() + '…' : rewrite;
    if (state.rewriteText !== visibleText) {
      state.rewriteDiv.firstElementChild.replaceChildren(renderRewrite(visibleText, state.textDiv));
      state.rewriteText = visibleText;
    }
    if (shortened) {
      if (!state.rewriteMoreEl || !state.rewriteMoreEl.isConnected) {
        state.rewriteMoreEl = makeLink(state.showMore.textContent.trim() || 'Show more', () => {
          state.rewriteExpanded = true;
          applyVisibility(state);
          state.rewriteDiv.tabIndex = -1;
          state.rewriteDiv.focus({ preventScroll: true });
        });
        state.rewriteMoreEl.classList.add('nms-show-more');
        state.rewriteMoreEl.setAttribute('aria-expanded', 'false');
      }
      NMS.copyTextStyle(state.showMore, state.rewriteMoreEl);
    } else if (state.rewriteMoreEl) {
      state.rewriteMoreEl.remove();
      state.rewriteMoreEl = null;
    }
    place(state);
  }

  function applyVisibility(state) {
    if (state.collapsed) { state.textDiv.classList.add('nms-hidden'); return; }
    if (!state.swapped) { state.textDiv.classList.remove('nms-hidden'); return; }
    updateRewrite(state);
    const orig = !!state.showingOriginal;
    state.textDiv.classList.toggle('nms-hidden', !orig);
    state.rewriteDiv.classList.toggle('nms-hidden', orig);
    state.rewriteDiv.classList.toggle('nms-full-rewrite', state.full);
    // Use our control for a complete rewrite; keep X's control for originals and partial rewrites.
    if (state.rewriteMoreEl) state.rewriteMoreEl.classList.toggle('nms-hidden', orig);
    if (state.showMore) state.showMore.classList.toggle('nms-hidden', !orig && state.full);
    state.toggleLink.textContent = orig ? 'Show rewrite' : 'Show original';
  }

  // The rewrite lives in a copy of X's own text element (same tag, classes, lang/dir) with a copy of
  // its inner text span, so font, size, wrapping and spacing are X's, not ours.
  function makeRewriteDiv(textDiv) {
    const div = textDiv.cloneNode(false);
    div.removeAttribute('data-testid');
    div.removeAttribute('id');
    div.classList.remove('nms-unit', 'nms-hidden', 'nms-pending');
    div.classList.add('nms-rewrite', 'nms-ui');
    const proto = textDiv.querySelector('span');
    const inner = document.createElement('span');
    if (proto) inner.className = proto.className;
    div.appendChild(inner);
    return div;
  }

  function addNote(state) {
    if (state.noteEl && state.noteEl.isConnected) return;
    const note = NMS.el('div', 'nms-note nms-ui', state.noteText);
    secondaryStyle(state, note, ['font-family', 'color']);
    state.noteEl = note;
    place(state);
  }

  // Display is decided here from the score and the LIVE settings; the background's flagged/hidden
  // booleans may predate a settings change.
  function render(state, result) {
    state.result = result;
    unblur(state);
    const score = Number(result.score) || 0;
    const rawHidden = S.hideCutoff <= 100 && score >= S.hideCutoff;
    const hidden = rawHidden && !state.forced && !state.forcedOriginal;
    const flagged = score >= S.cutoff;
    const differs = typeof result.rewrite === 'string' && result.rewrite.trim() !== '' && normText(result.rewrite) !== normText(state.text);
    if (flagged && !hidden && result.rewrite == null && !state.retried && !state.forcedOriginal && !stopped && S.enabled && NMS.alive) {
      // The background answered before it saw the new cutoff: ask once more (cache hit for the score).
      state.retried = true;
      enqueue(state);
      return;
    }
    if (!state.forced) { if (memo.size > 3000) memo.clear(); memo.set(state.text, result); }
    const swap = flagged && !hidden && differs;
    setCollapsed(state, hidden, result);
    setSwap(state, swap);
    const wantBadge = S.showScores || swap || rawHidden || state.forced;
    setBadge(state, wantBadge ? NMS.badge(score, result.reason, { separator: true }) : null);
    if (state.forcedOriginal && state.noteText && !state.noteEl && (swap || rawHidden)) addNote(state);
    schedulePageCounts();
  }

  // ---------- page counts ----------

  const schedulePageCounts = NMS.debounce(() => {
    if (!NMS.alive) return;
    let rewritten = 0, hidden = 0;
    for (const [textDiv, st] of units) {
      if (!textDiv.isConnected) continue;
      if (st.collapsed) hidden++;
      else if (st.swapped) rewritten++;
    }
    NMS.bg({ type: 'pageCounts', rewritten, hidden });
  }, 300);

  // ---------- scanning ----------

  let scanTimer = 0;
  function scan() {
    if (scanTimer || stopped === 'dead') return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      prune();
      if (!S.enabled || stopped || document.hidden || !NMS.alive) return;
      for (const article of document.querySelectorAll(SEL_POST)) collectUnits(article);
    }, 50);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) if (m.type === 'characterData' || m.addedNodes.length || m.removedNodes.length) { scan(); return; }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) scan(); });

  // ---------- settings ----------

  function teardownAll() {
    gen++;
    queue = [];
    clearTimeout(flushTimer);
    memo.clear();
    for (const st of units.values()) teardownUnit(st);
    units.clear();
    schedulePageCounts();
  }

  // Re-send everything on screen (cache hits are free); results from before this call are ignored.
  function refreshAll() {
    gen++;
    queue = [];
    clearTimeout(flushTimer);
    memo.clear();
    for (const [textDiv, st] of [...units]) {
      if (!textDiv.isConnected) { unblur(st); units.delete(textDiv); continue; }
      if (st.skipped) continue;
      st.retried = false;
      enqueue(st);
    }
    scan();
  }

  NMS.onSettings((changed) => {
    if (stopped === 'dead') return;
    if ('enabled' in changed && !changed.enabled) { teardownAll(); return; }
    if (stopped === 'cap') stopped = null;                       // the popup changed something: try again
    if (stopped === 'no-key' && changed.credentials) stopped = null;
    if ('blurPending' in changed && !changed.blurPending) for (const st of units.values()) unblur(st);
    refreshAll();
  });

  // ---------- public surface ----------

  // Show the original wording of every rewritten/collapsed unit inside scopeEl (badge and toggle
  // stay) and put noteText on a small secondary line under it, once per unit. Units that are still
  // pending are marked too, so they come up as originals when their score arrives.
  function forceOriginal(scopeEl, noteText) {
    if (!scopeEl) return 0;
    if (scopeEl.matches && scopeEl.matches(SEL_POST)) collectUnits(scopeEl);
    for (const article of scopeEl.querySelectorAll ? scopeEl.querySelectorAll(SEL_POST) : []) collectUnits(article);
    let n = 0;
    for (const [textDiv, st] of units) {
      if (st.skipped || !textDiv.isConnected || !scopeEl.contains(textDiv)) continue;
      st.forcedOriginal = true;
      st.showingOriginal = true;
      if (noteText && !st.noteText) st.noteText = noteText;
      if (!st.result) continue;
      const wasShown = st.swapped || st.collapsed;
      render(st, st.result);
      if (wasShown) n++;
    }
    return n;
  }

  NMS.core = { units, forceOriginal, refresh: refreshAll };

  NMS.ready.then(() => {
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    if (S.enabled) scan();
  });

  // Test harness hook (scripts/test-shim.js defines window.__nmsTest; never present in a real install).
  if (window.__nmsTest) {
    window.__nmsTest.internals = {
      scan, refresh: refreshAll, units, memo, batchLog, flush, settings: () => S,
      get gen() { return gen; }, get stopped() { return stopped; }, get queue() { return queue; },
    };
  }

  // Dev convenience for unpacked installs: `window.postMessage({ type: 'nms-dev-reload' }, '*')`
  // reloads the extension without a trip to chrome://extensions.
  let devInstall = false;
  try { devInstall = !chrome.runtime.getManifest().update_url; } catch (_) {}
  if (devInstall) {
    window.addEventListener('message', (e) => {
      if (e.source === window && e.data && e.data.type === 'nms-dev-reload') NMS.bg({ type: 'devReload' });
    });
  }
})();
