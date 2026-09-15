// Browser regressions for long posts. Requires Playwright and Chromium (or NMS_TEST_CHANNEL=chrome).
// Run: node scripts/content-test.js
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const root = process.env.NMS_SOURCE_DIR || path.resolve(__dirname, '..');
const preview = 'Some questions:\n- This media is…';
const full = 'Some questions:\n- This media is going viral. Why?\n- How will this work?\n- What happens next?';
const rewrite = 'Some questions:\n- Why is this media spreading?\n- How would this work?\n- What comes next?';
const rewritePreview = 'Some questions:\n- Why is this m…';
const result = (text) => ({ ok: true, results: [{ ok: true, score: 22, reason: 'pointed', rewrite: text }] });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function fixture(page, { hook = false, text = preview, more = true, quote = false } = {}) {
  await page.route('https://x.com/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body></body>',
  }));
  await page.goto('https://x.com/nms-test');
  await page.evaluate(({ text, more, quote }) => {
    document.body.innerHTML = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/author">Author</a><a href="/author/status/123456"><time>2h</time></a></div>
      <div id="body"><div data-testid="tweetText" lang="en"><span></span></div></div>
      <div role="group"></div>
    </article>`;
    document.querySelector('[data-testid="tweetText"] span').textContent = text;
    if (more) document.querySelector('#body').insertAdjacentHTML('beforeend', '<button data-testid="tweet-text-show-more-link">Show more</button>');
    if (quote) document.querySelector('article').insertAdjacentHTML('beforeend', '<div role="link"><div data-testid="User-Name"><a href="/quoted">Quoted author</a></div><div><div data-testid="tweetText"><span>A separate quoted post…</span></div></div></div>');
    window.requests = [];
    window.messages = [];
    window.addEventListener('message', (e) => { if (e.source === window) messages.push(e.data); });
    window.chrome = {
      storage: {
        local: { get: async () => ({ enabled: true, cutoff: 0, hideCutoff: 101, blurPending: false }) },
        onChanged: { addListener(fn) { window.settingsListener = fn; } },
      },
      runtime: {
        getManifest: () => ({ update_url: 'test' }),
        sendMessage: (msg) => msg.type === 'analyze'
          ? new Promise((resolve) => requests.push({ msg, resolve }))
          : Promise.resolve({ ok: true }),
      },
    };
    window.__nmsTest = {};
  }, { text, more, quote });
  await page.addStyleTag({ path: path.join(root, 'content/content.css') });
  if (hook) await page.addScriptTag({ path: path.join(root, 'content/page-hook.js') });
}
async function start(page) {
  await page.addScriptTag({ path: path.join(root, 'content/common.js') });
  await page.addScriptTag({ path: path.join(root, 'content/content.js') });
}
async function request(page, index) {
  await page.waitForFunction((i) => requests.length > i, index, { timeout: 3000 });
  return page.evaluate((i) => requests[i].msg.items[0], index);
}
async function resolve(page, index, response) {
  await page.evaluate(({ index, response }) => requests[index].resolve(response), { index, response });
}
async function expectRewrite(page, text, visible = true) {
  await page.waitForFunction(({ text, visible }) => {
    const el = document.querySelector('.nms-rewrite');
    return el?.textContent === text && (getComputedStyle(el).display !== 'none') === visible;
  }, { text, visible }, { timeout: 3000 });
}
async function note(page) {
  await page.evaluate((full) => window.postMessage({ type: 'nms-notes', notes: { '123456': full } }, location.origin), full);
}
async function expand(page) {
  await page.evaluate((full) => {
    document.querySelector('[data-testid="tweetText"] span').textContent = full;
    document.querySelector('[data-testid="tweet-text-show-more-link"]')?.remove();
  }, full);
}

for (const transport of ['fetch', 'xhr']) test(`replays early full text captured through ${transport}`, async (page) => {
  await fixture(page, { hook: true });
  await page.route('**/i/api/graphql/**', (route) => route.fulfill({ json: {
    data: { tweet: { rest_id: '123456', note_tweet: { note_tweet_results: { result: { text: full } } } } },
  } }));
  await page.evaluate((transport) => {
    const url = '/i/api/graphql/fixture/TweetDetail';
    if (transport === 'fetch') return fetch(url).then((r) => r.text());
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.onload = resolve;
      xhr.onerror = reject;
      xhr.send();
    });
  }, transport);
  await page.waitForFunction(() => messages.some((m) => m.type === 'nms-notes'));
  await start(page);
  assert.equal((await request(page, 0)).text, full);
  await resolve(page, 0, result(rewrite));
  await expectRewrite(page, rewritePreview);
  assert.equal(await page.locator('[data-testid="tweet-text-show-more-link"]').isVisible(), false);
  assert.equal(await page.locator('.nms-show-more').isVisible(), true);
  await page.getByText('Show original', { exact: true }).click();
  assert.equal(await page.locator('[data-testid="tweet-text-show-more-link"]').isVisible(), true);
});

test('keeps a replacement Show more button hidden for an existing full rewrite', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="tweet-text-show-more-link"]');
    const next = button.cloneNode(true);
    next.classList.remove('nms-hidden');
    button.replaceWith(next);
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="tweet-text-show-more-link"]').classList.contains('nms-hidden'));
  assert.equal(await page.evaluate(() => requests.length), 2);
});

for (const expanded of [false, true]) test(`X resetting native button classes leaves ${expanded ? 'no control after expansion' : 'one Show more'}`, async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  if (expanded) {
    await page.locator('.nms-show-more').click();
    await expectRewrite(page, rewrite);
  }
  // React can update className on the same node, stripping our nms-hidden class.
  // The tweet text and button identity have not changed, so a rescan needn't rerender the unit.
  await page.evaluate(() => {
    document.querySelector('[data-testid="tweet-text-show-more-link"]').className = 'x-native-button';
  });
  assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), expanded ? 0 : 1);
  await page.getByText('Show original', { exact: true }).click();
  assert.equal(await page.locator('[data-testid="tweet-text-show-more-link"]').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), 1);
  await page.getByText('Show rewrite', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), expanded ? 0 : 1);
  await page.evaluate(() => settingsListener({ enabled: { newValue: false } }, 'local'));
  assert.equal(await page.locator('[data-testid="tweet-text-show-more-link"]').isVisible(), true);
});

test('Show more refreshes the rewrite when X reuses the same text element', async (page) => {
  await fixture(page);
  await start(page);
  assert.equal((await request(page, 0)).truncated, true);
  await resolve(page, 0, result('Some questions:\n- The media is…'));
  await expectRewrite(page, 'Some questions:\n- The media is…');
  await expand(page);
  const expanded = await request(page, 1);
  assert.equal(expanded.text, full);
  assert.equal(expanded.truncated, undefined);
  assert.equal(await page.locator('.nms-rewrite').count(), 0);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewrite);
});

test('late preview responses cannot overwrite a full rewrite or its cache', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  assert.equal((await request(page, 1)).text, full);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  await resolve(page, 0, result('Obsolete preview…'));
  await expectRewrite(page, rewritePreview);
  assert.equal(await page.evaluate((full) => __nmsTest.internals.memo.get(full).rewrite, full), rewrite);
});

test('late preview errors do not replace the full post score', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await expand(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewrite);
  await resolve(page, 0, { ok: false, error: 'no-key' });
  assert.equal(await page.evaluate(() => __nmsTest.internals.stopped), null);
  await expectRewrite(page, rewrite);
});

test('preserves Show original when an expanded post is analyzed again', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await resolve(page, 0, result('Shorter wording…'));
  await expectRewrite(page, 'Shorter wording…');
  await page.getByText('Show original', { exact: true }).click();
  await expand(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewrite, false);
  assert.equal(await page.locator('[data-testid="tweetText"]').textContent(), full);
  await page.getByText('Show rewrite', { exact: true }).click();
  await expectRewrite(page, rewrite);
});

test('detects character-data-only updates without a Show more button', async (page) => {
  await fixture(page, { more: false });
  await start(page);
  await request(page, 0);
  await page.evaluate((full) => { document.querySelector('[data-testid="tweetText"] span').firstChild.nodeValue = full; }, full);
  assert.equal((await request(page, 1)).text, full);
});

test('expanding the main post keeps the quoted post independent', async (page) => {
  await fixture(page, { quote: true });
  await start(page);
  await request(page, 1);
  await note(page);
  assert.equal((await request(page, 2)).text, full);
  const texts = await page.evaluate(() => [...__nmsTest.internals.units.values()].map((st) => ({ quoted: st.quoted, text: st.text })));
  assert.equal(texts.find((st) => st.quoted).text, 'A separate quoted post…');
});

test('reuses the full-text memo when the same preview is mounted again', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  await page.evaluate(() => {
    const article = document.querySelector('article');
    const replacement = article.cloneNode(true);
    replacement.querySelectorAll('.nms-ui').forEach((el) => el.remove());
    replacement.querySelectorAll('.nms-hidden').forEach((el) => el.classList.remove('nms-hidden'));
    article.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.querySelector('.nms-rewrite'));
  await expectRewrite(page, rewritePreview);
  assert.equal(await page.evaluate(() => requests.length), 2);
});

for (const { width, height, key } of [
  { width: 1280, height: 800, key: null },
  { width: 375, height: 812, key: 'Enter' },
  { width: 812, height: 375, key: 'Space' },
]) test(`long rewrite previews and expands at ${width}px (${key || 'click'})`, async (page) => {
  await page.setViewportSize({ width, height });
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  const more = page.locator('.nms-show-more');
  assert.equal(await more.textContent(), 'Show more');
  assert.equal(await more.isVisible(), true);
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), 1);
  await page.evaluate(() => {
    window.postClicks = 0;
    document.querySelector('article').addEventListener('click', () => postClicks++);
  });
  if (key) { await more.focus(); await more.press(key); }
  else await more.click();
  await expectRewrite(page, rewrite);
  assert.equal(await more.count(), 0);
  assert.equal(await page.evaluate(() => postClicks), 0);
  assert.equal(await page.evaluate(() => requests.length), 2);
  assert.equal(page.url(), 'https://x.com/nms-test');
  await page.getByText('Show original', { exact: true }).click();
  assert.equal(await page.locator('[data-testid="tweetText"]').textContent(), preview);
  assert.equal(await page.locator('[data-testid="tweet-text-show-more-link"]').isVisible(), true);
  await page.getByText('Show rewrite', { exact: true }).click();
  await expectRewrite(page, rewrite);
  assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), 0);
  // A settings refresh can return another cached result without folding the post again.
  await page.evaluate(() => NMS.core.refresh());
  await request(page, 2);
  await resolve(page, 2, result(rewrite));
  await expectRewrite(page, rewrite);
});

test('original/rewrite toggles preserve an unexpanded rewrite preview', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  await page.getByText('Show original', { exact: true }).click();
  assert.equal(await page.locator('.nms-show-more').isVisible(), false);
  await page.getByText('Show rewrite', { exact: true }).click();
  await expectRewrite(page, rewritePreview);
  assert.equal(await page.locator('.nms-show-more').isVisible(), true);
});

test('a rewrite that fits the preview needs no Show more control', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result('Why is this spreading?'));
  await expectRewrite(page, 'Why is this spreading?');
  assert.equal(await page.getByRole('button', { name: 'Show more', exact: true }).count(), 0);
});

test('an already expanded original shows the full rewrite immediately', async (page) => {
  await fixture(page, { text: full, more: false });
  await start(page);
  await request(page, 0);
  await resolve(page, 0, result(rewrite));
  await expectRewrite(page, rewrite);
  assert.equal(await page.locator('.nms-show-more').count(), 0);
});

test('disabling the extension removes its Show more and restores the native control', async (page) => {
  await fixture(page);
  await start(page);
  await request(page, 0);
  await note(page);
  await request(page, 1);
  await resolve(page, 1, result(rewrite));
  await expectRewrite(page, rewritePreview);
  await page.evaluate(() => settingsListener({ enabled: { newValue: false } }, 'local'));
  assert.equal(await page.locator('.nms-show-more, .nms-rewrite').count(), 0);
  assert.equal(await page.locator('[data-testid="tweet-text-show-more-link"]').isVisible(), true);
  assert.equal(await page.locator('[data-testid="tweetText"]').isVisible(), true);
});

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.NMS_TEST_CHANNEL ? { channel: process.env.NMS_TEST_CHANNEL } : {}) });
  let failed = 0;
  try {
    for (const { name, fn } of tests) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try { await fn(page); assert.deepEqual(errors, []); console.log(`PASS ${name}`); }
      catch (error) { failed++; console.error(`FAIL ${name}\n${error.message}`); }
      finally { await page.close(); }
    }
  } finally { await browser.close(); }
  console.log(`${tests.length - failed}/${tests.length} browser regressions passed`);
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
