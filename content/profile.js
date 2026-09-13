// profile.js — author heat on profile pages (see docs/architecture.md)
// Shows the average score of the last ≤30 scored posts from the profile's account next to its @handle.
(() => {
  'use strict';
  const NMS = window.NMS;
  if (!NMS || NMS.profile) return;

  const SEL_HEADER = '[data-testid="UserName"]'; // capital N: the profile header, not a post's User-Name
  const URL_MS = 500;        // X is an SPA: poll the URL (plus popstate)
  const POLL_MS = 3000;      // content.js keeps scoring posts as they load, so the average moves
  const IDLE_MS = 30000;     // stop polling once n has not changed for this long; a scroll restarts it
  const MOUNT_RETRY_MS = 300;

  let handle = '';           // profile we are on ('' elsewhere)
  let gen = 0;               // bumped on every page change; responses from an older page are dropped
  let pill = null;
  let last = null;           // last authorHeat response for this page
  let lastN = -1, lastChangeAt = 0, lastHref = '';
  let pollTimer = 0, mountTimer = 0;

  const handleFromPath = (p) => { const m = p.match(/^\/([A-Za-z0-9_]{1,15})/); return m ? m[1] : ''; };

  // ---------- page changes ----------

  function checkUrl() {
    if (!NMS.alive || location.href === lastHref) return;
    lastHref = location.href;
    const h = NMS.isProfilePath(location.pathname) ? handleFromPath(location.pathname) : '';
    if (h.toLowerCase() === handle.toLowerCase()) return;
    leave();
    if (h) enter(h);
  }

  function enter(h) {
    handle = h;
    gen++;
    last = null;
    lastN = -1;
    lastChangeAt = Date.now();
    startPolling();
    ensureMounted();
  }

  function leave() {
    handle = '';
    gen++;
    stopPolling();
    clearTimeout(mountTimer);
    mountTimer = 0;
    if (pill) { pill.remove(); pill = null; }
  }

  // ---------- polling ----------

  function startPolling() {
    if (pollTimer || !handle) return;
    tick();
    pollTimer = setInterval(tick, POLL_MS);
  }

  function stopPolling() { clearInterval(pollTimer); pollTimer = 0; }

  async function tick() {
    if (!NMS.alive) { stopPolling(); return; }
    if (!handle || document.hidden) return;
    if (!NMS.settings.enabled) { render(null); return; }
    const g = gen;
    const res = await NMS.bg({ type: 'authorHeat', handle });
    if (g !== gen) return;
    if (!res || !res.ok) { render(null); return; }
    if (res.n !== lastN) { lastN = res.n; lastChangeAt = Date.now(); }
    else if (Date.now() - lastChangeAt >= IDLE_MS) stopPolling();
    last = res;
    render(res);
  }

  // ---------- rendering ----------

  function header() {
    const want = '@' + handle.toLowerCase();
    for (const el of document.querySelectorAll(SEL_HEADER)) {
      if (el.textContent.toLowerCase().includes(want)) return el;
    }
    return null;
  }

  // Verified 2026-09-13: UserName > … > div(flex column: [display-name row, handle row]). The handle row is the
  // nearest flex-row ancestor of the "@handle" span; on other people's profiles it also holds the "Follows you" chip.
  function handleRow(hdr) {
    const want = '@' + handle.toLowerCase();
    const span = [...hdr.querySelectorAll('span')].find((s) => s.textContent.trim().toLowerCase() === want);
    if (!span) return null;
    for (let e = span.parentElement; e && e !== hdr; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'flex' && cs.flexDirection === 'row') return { row: e, span };
    }
    return { row: span.parentElement, span };
  }

  function ensureMounted() {
    clearTimeout(mountTimer);
    mountTimer = 0;
    if (!handle) return;
    if (pill && pill.isConnected) return;
    const hdr = header();
    const spot = hdr && handleRow(hdr);
    if (!spot) { mountTimer = setTimeout(ensureMounted, MOUNT_RETRY_MS); return; }
    if (!pill) pill = NMS.el('span', 'nms-heat nms-ui');
    // Theme-safe: primary colour from the header, secondary from the @handle span.
    NMS.copyTextStyle(spot.span, pill, ['font-family']);
    pill.style.color = getComputedStyle(hdr).color;
    pill.style.setProperty('--nms-heat-primary', getComputedStyle(hdr).color);
    pill.style.setProperty('--nms-heat-secondary', getComputedStyle(spot.span).color);
    spot.row.appendChild(pill);
    render(last);
  }

  function render(res) {
    if (!pill) return;
    const key = !res || !NMS.settings.enabled ? 'off' : `${res.avg}/${res.n}`;
    if (pill.dataset.key === key) return;
    pill.dataset.key = key;
    if (key === 'off') { pill.classList.add('nms-heat-off'); return; }
    pill.classList.remove('nms-heat-off');
    if (!res.n) {
      pill.classList.add('nms-heat-empty');
      pill.replaceChildren(NMS.el('span', 'nms-heat-meta', 'no posts scored yet'));
      pill.title = 'No posts from this account have been scored yet';
      return;
    }
    pill.classList.remove('nms-heat-empty');
    const badge = NMS.badge(res.avg, '');
    badge.title = '';
    pill.replaceChildren(badge, NMS.el('span', 'nms-heat-meta', `avg of ${res.n} post${res.n === 1 ? '' : 's'}`));
    pill.title = `Average inflammatory-wording score of the last ${res.n} posts seen from this account`;
  }

  // ---------- wiring ----------

  const remount = NMS.debounce(() => { if (handle && !(pill && pill.isConnected)) ensureMounted(); }, 150);

  NMS.onSettings((changed) => {
    if (!('enabled' in changed)) return;
    if (changed.enabled) { lastChangeAt = Date.now(); startPolling(); } // ticks immediately
    else { stopPolling(); render(null); }
  });

  document.addEventListener('scroll', () => {
    if (!handle || pollTimer) return;
    lastChangeAt = Date.now();
    startPolling();
  }, { capture: true, passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !handle) return;
    lastChangeAt = Date.now();
    startPolling();
    tick();
  });
  window.addEventListener('popstate', checkUrl);

  NMS.ready.then(() => {
    setInterval(checkUrl, URL_MS);
    new MutationObserver((muts) => {
      for (const m of muts) if (m.addedNodes.length || m.removedNodes.length) { remount(); return; }
    }).observe(document.body, { childList: true, subtree: true });
    checkUrl();
  });

  NMS.profile = { checkUrl, tick, ensureMounted, state: () => ({ handle, lastN, polling: !!pollTimer, mounted: !!(pill && pill.isConnected) }) };
})();
