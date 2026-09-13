# No More Scissors — architecture and contracts (v2.1)

This file is the contract between the pieces. If you change a message shape or a settings key,
change it here first.

## Files and ownership

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Content scripts load in order: `content/common.js`, `content/content.js`, `content/composer.js`, `content/profile.js`. CSS: `content/content.css`, `content/extras.css`. |
| `background.js` | Service worker. Owns keys, providers, request queue, cache, stats, spend cap, author heat, toolbar badge. |
| `content/common.js` | Shared helpers for all content scripts (`window.NMS`). Frozen: don't edit; add helpers in your own file. |
| `content/content.js` | Timeline core: finds posts, batches them to the background, renders badges / rewrites / collapsed posts. Exposes `NMS.core`. |
| `content/content.css` | Styles for the core. |
| `content/composer.js` | Live score on the compose box; "replying to the original" behaviour. |
| `content/profile.js` | Author heat pill on profile pages. |
| `content/extras.css` | Styles for composer.js and profile.js. |
| `popup/*` | Settings popup. |
| `onboarding/*` | First-run page (opened on install); also the calibration page (`onboarding.html#calibrate`, linked from the popup). `calibration-posts.js` holds the example posts. |
| `scripts/test-shim.js`, `scripts/build-test-bundle.sh` | Fake `chrome.*` + bundle to paste into an x.com console for testing without installing. |
| `scripts/bg-test.js` | Node test for background.js (fake chrome + fetch). |
| `scripts/package.sh`, `scripts/make-promo.py`, `store/*` | Web Store packaging. |

## Settings (`chrome.storage.local`, flat keys)

```js
const DEFAULTS = {
  provider: 'openai',        // 'openai' | 'anthropic' | 'compatible'
  apiKey: '',                // OpenAI key
  anthropicKey: '',          // Anthropic key
  compatibleKey: '',         // key for the custom endpoint (may be empty, e.g. Ollama)
  baseUrl: '',               // compatible only, e.g. 'http://localhost:11434/v1' (no trailing slash; '/chat/completions' is appended)
  enabled: true,
  cutoff: 40,                // rewrite posts scoring >= cutoff (0–100)
  hideCutoff: 85,            // collapse posts scoring >= hideCutoff; 101 means never
  showScores: true,          // badge on every post; false = only on rewritten/collapsed posts
  blurPending: true,         // blur post text until scored (max ~4 s, then it fades in anyway)
  scoreModel: 'gpt-5.4-nano',
  rewriteModel: 'gpt-5.4-mini',
  rewriteStyle: 'neutral',   // 'light' | 'neutral' | 'kind' | 'custom'
  customStyle: '',           // extra instruction when rewriteStyle === 'custom'
  spendCap: 10,              // USD per calendar month across all models; 0 = no cap
  onboarded: false,          // onboarding page sets true
  calibration: [],           // [{ id, text, score }] — the user's own ratings of the built-in example posts
                             // (onboarding/calibration-posts.js; score = band value 10/30/50/70/90). Empty = not calibrated.
};
```

Provider defaults for models (the popup and the onboarding page apply these when the provider changes):

| provider | scoreModel | rewriteModel |
|---|---|---|
| openai | `gpt-5.4-nano` | `gpt-5.4-mini` |
| anthropic | `claude-haiku-4-5` | `claude-opus-5` |
| compatible | `''` (user types) | `''` |

Active key = `apiKey` / `anthropicKey` / `compatibleKey` by provider. Content scripts never read keys; they rely on the background's `no-key` error and refresh when any of `provider, apiKey, anthropicKey, compatibleKey, baseUrl` changes.

Other storage keys (background-owned): `c:<hash>` cache entries `{s, r, w, wk, t}` (score, reason, rewrite, rewrite style key, last used); `a:<handle>` author history `{ids: [...], scores: [...]}` (last 30 distinct posts); `stats`.

## Messages to the background (`chrome.runtime.sendMessage`)

All responses are objects with `ok`. When nothing can proceed, the top-level response is `{ ok: false, error }` with `error` one of `'no-key'`, `'cap'` (monthly spend cap reached), `'disabled'`, or a human-readable message.

### `analyze` — score (and rewrite) posts, batched

```js
{ type: 'analyze', items: [{ id, text, lang, author, force }] }
// id: post id string if known ('' otherwise); author: handle without '@' ('' if unknown);
// force: true asks for a rewrite even when the post is above hideCutoff (used by "Show anyway").
→ { ok: true, results: [ per item:
     { ok: true, score, reason, flagged, hidden, rewrite }   // rewrite is a string or null
   | { ok: false, error } ] }
```

Semantics (background): `flagged = score >= cutoff`; `hidden = score >= hideCutoff`; a rewrite is produced (and cached) when `flagged && (!hidden || force)`. Author handles are normalised (no `@`, lower-case). Quoted posts have no status link, so the content script sends `id: 'q' + hash(text)` for them. When `enabled` is false the background answers `{ok:false, error:'disabled'}`. When the spend cap is reached, a batch that can be served entirely from cache still succeeds; anything needing an API call gets the top-level `'cap'` error. Per-item failures come back as `{ok:false, error}` inside `results` with top-level `ok:true`. Scores are cached by text hash forever; rewrites are cached with the style key (`wk`) and regenerated when the style changes. Uncached items are scored in chunks of up to 8 per API call. Identical texts in flight are deduped. When `id` and `author` are present the score is recorded in the author's history. Always send an array, even for one item. The content script sends posts that are on screen one per request (fastest first paint) and batches the rest by distance from the viewport. The content script decides how to *display* a result from `score` and the live settings; it re-sends `analyze` when settings change (cache hits are free).

### `score` — score only (composer)

```js
{ type: 'score', text } → { ok: true, score, reason } | { ok: false, error }
```
Cached like any post; never rewrites; never records author history.

### `scoreMany` — score several texts, nothing else (calibration check)

```js
{ type: 'scoreMany', texts: ['…', '…'] } → { ok: true, results: [ { ok: true, score, reason } | { ok: false, error } ] }
```
Batched like `analyze`, cached, never rewrites, never records author history.

### `authorHeat`

```js
{ type: 'authorHeat', handle } → { ok: true, avg, n, scores }   // avg rounded 0–100 or null when n === 0; n ≤ 30
```

### `pageCounts` — drives the toolbar badge

```js
{ type: 'pageCounts', rewritten, hidden } → { ok: true }
```
Background sets `chrome.action` badge text for the sending tab to `rewritten + hidden` (empty when 0). Global states win: `!` (red) when the active provider has no key or the last error was an invalid key; `$` (amber) when the spend cap is reached.

### Others

```js
{ type: 'testKey', provider?, apiKey?, baseUrl? }  → { ok, error?, note? }    // defaults to saved settings
{ type: 'getStats' } → { ok: true, stats, cacheSize, costTotal, costMonth, costEstimated, capReached, month }
   // stats: { scored, rewritten, usage: {model: {in, out, calls}}, month: 'YYYY-MM',
   //          monthUsage: {model: {in, out, calls}}, lastError, lastErrorAt }
{ type: 'clearCache' } → { ok: true }
{ type: 'resetStats' } → { ok: true }
{ type: 'openOnboarding' } → { ok: true }     // opens onboarding/onboarding.html in a tab
{ type: 'devReload' } → reloads an unpacked install
```

## Providers (background)

- **openai**: `POST https://api.openai.com/v1/chat/completions`, `Authorization: Bearer`, `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`, `max_completion_tokens`, no temperature. `reasoning_effort`: `'minimal'` for `gpt-5`, `gpt-5-mini`, `gpt-5-nano`; `'none'` for `gpt-5.x`; omitted otherwise; a 400 mentioning reasoning retries without it.
- **compatible**: same request to `${baseUrl}/chat/completions` with the compatible key (header omitted when the key is empty). Degrade gracefully: on a 400 that mentions `response_format` / `json_schema`, retry with `{ type: 'json_object' }`; if that fails, retry with no `response_format` and parse the first `{…}` in the reply.
- **anthropic**: `POST https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`. Body: `{ model, max_tokens, system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema } } }`. Add `output_config.effort: 'low'` for `claude-opus-*`, `claude-sonnet-5*`, `claude-fable-*` (Haiku 4.5 rejects `effort`; a 400 mentioning effort retries without it). For `claude-opus-5*` and `claude-fable-*` also send header `anthropic-beta: server-side-fallback-2026-07-01` and body `fallbacks: 'default'`. Read the JSON from the first `text` content block. Check `stop_reason` before reading content: `'refusal'` → error "Model declined this post"; `'max_tokens'` → error. Usage: `usage.input_tokens`, `usage.output_tokens`.
- Retries: up to 3 attempts on 429 / 5xx / network with backoff (honour `retry-after`); 401 → fatal "Invalid API key"; 404 / unknown model → fatal; `insufficient_quota` → fatal "no credits".
- Concurrency: 4 requests in flight.

## Prices (USD per 1M tokens; background owns the table, popup asks `getStats`)

openai: gpt-5.4-nano 0.20/1.25 · gpt-5.4-mini 0.75/4.50 · gpt-5.4 2.50/15 · gpt-5.6-luna 0.20/1.20 · gpt-4.1-mini 0.40/1.60 · gpt-4.1-nano 0.10/0.40 · gpt-5-mini 0.25/2.00 · gpt-5-nano 0.05/0.40 · gpt-4o-mini 0.15/0.60 · gpt-4o 2.50/10
anthropic: claude-haiku-4-5 1/5 · claude-sonnet-5 2/10 · claude-sonnet-4-6 3/15 · claude-opus-5 5/25 · claude-opus-4-8 5/25 · claude-opus-4-7 5/25
Unknown models are estimated at 1/5 and `costEstimated` is true. Match model ids by prefix (dated snapshots).

## Prompts (background)

- Calibration: when `settings.calibration` is non-empty, the background appends a block to the END of the shared score system prompt (so the shared prefix still caches): `## This user's calibration` + one line per rating `- "<text>" → <score>`, telling the model to match this person's scale. Changing `calibration` clears cached scores (rewrites are kept). Bands: fine 10 · snarky 30 · hostile 50 · cruel 70 · abusive 90.
- Score rubric: 0–100 (0–19 neutral/earnest · 20–39 pointed/snarky · 40–59 hostile/contemptuous · 60–79 insults, dehumanising, rage bait · 80–100 slurs/threats/calls for harm). Judge tone and framing, not topic. Strong opinions, criticism, bad news, casual profanity, dark humour, and anger at events are not inflammatory by themselves; contempt for people is. The system prompt carries ≥ 1,024 tokens of calibration examples so provider prompt caching applies (OpenAI: 1,024-token minimum; Anthropic Opus 5: 512; Sonnet 5 / Opus 4.8: 1,024; Haiku 4.5 needs 4,096, so the default Anthropic score model does not get cache hits). Batch format: user message lists posts as `### Post 1`, `### Post 2`, … ; schema `{ results: [{ index, score, reason }] }` with `index` = post number; `reason` ≤ 8 words.
- Rewrite: keep every claim/opinion/joke, voice, person, register, language, mentions, hashtags, URLs, emoji, line breaks; never longer; return unchanged if already calm. Style presets append a paragraph: **light** = change as few words as possible, only the hostile ones; **neutral** = current behaviour; **kind** = additionally assume good faith and phrase disagreement generously; **custom** = the user's instruction verbatim. Schema `{ rewrite }`.

## Content script contracts

`window.NMS` (from `common.js`): `bg(msg)`, `settings` (live), `ready` (promise), `onSettings(cb)`, `extractText(root)`, `scoreColor(score)`, `scoreLabel(score)`, `el(tag, cls, text)`, `badge(score, reason, opts)`, `copyTextStyle(from, to)`, `postId(article)`, `authorOf(scope)`, `debounce(fn, ms)`, `isProfilePath(pathname)`.

`NMS.core` (from `content.js`): `units` (Map textDiv → state), `forceOriginal(scopeEl, noteText)` — for every rewritten/collapsed unit inside `scopeEl`, show the original wording and put `noteText` on a small secondary-coloured line under it; units still pending inside the scope are marked so they come up as originals once scored; `refresh()`.

### X DOM anchors (verified 2026-09-13)

- Post: `article[data-testid="tweet"]`. Own text: first `[data-testid="tweetText"]` not inside a `div[role="link"]` descendant. Quoted post: `div[role="link"]` inside the article that contains its own `[data-testid="tweetText"]` and `[data-testid="User-Name"]`.
- Header: `[data-testid="User-Name"]`; it contains `<time>` inside `a[href*="/status/"]` (href gives the post id). The badge slot is `time.closest('a').parentElement` (a one-child flex div). In quoted posts `<time>` is not inside an `<a>` and there is no `/status/` link — use `time.parentElement`. `<time>` is 15px TwitterChirp, X's secondary colour. Put the badge as the last child of the element that holds that `<time>` link, rendered like X's own "· 4h" metadata: a "·" separator, coloured dot, number; font-size and colour copied from the `<time>` element (X's secondary text colour), no background. Tooltip = reason.
- Author handle: inside `User-Name`, the first `a[href^="/"]` whose pathname is a single segment.
- Action bar: `div[role="group"]` (absent in quoted posts).
- Text: mentions/links are wrapped in `inline-flex` divs — decide block vs inline with `getComputedStyle`, not tags. Emoji are `<img alt>`; long posts end in an `a[data-testid="tweet-text-show-more-link"]`. `tweetText` carries `lang`.
- Media: `[data-testid="tweetPhoto"]`, `[data-testid="videoPlayer"]`, `[data-testid="card.wrapper"]`.
- "Show more" link style (mimic for our "Show original" / "Show anyway" links): X blue `rgb(29,155,240)`, same font as the post text, no underline, cursor pointer.
- Composer: `[data-testid="tweetTextarea_0"]` (contenteditable, Draft.js; paragraphs are `[data-block="true"]`), Post button `[data-testid="tweetButtonInline"]` or `[data-testid="tweetButton"]`. Toolbar: `[data-testid="toolBar"]` > [nav, flex-row div > flex-column div > the Post button]; the composer badge is inserted before the button's column slot in that flex row. Reply modal: `[role="dialog"]` containing the textarea and the parent post's `tweetText`; Escape does not close it (use its close button). Inline reply (post page): the reply box lives INSIDE the focal post's own `[data-testid="cellInnerDiv"]`. Focus events don't bubble past X's React root — listen for `focusin`/`focusout` in the capture phase and reconcile with `document.activeElement`.
- Profile page: pathname `/<handle>` (one segment, not `home|explore|notifications|messages|search|settings|compose|i|jobs`), header `[data-testid="UserName"]` (capital N — different from posts); the heat pill goes on the flex-row that holds the `@handle` span (the row that also shows "Follows you").
- Themes: never hard-code black/white. Copy colours from X elements (`time` for secondary, `tweetText` for primary) or use `currentColor` + `color-mix`.
- Never post, like, follow, or otherwise act on X while testing. Close the reply modal with Escape.

## Testing

- `node scripts/bg-test.js` — background unit test with fake chrome + fetch. Must pass.
- `scripts/build-test-bundle.sh /tmp/nms-bundle.js` then paste into the console of a logged-in x.com tab. `__nmsTest` exposes `mem` (settings), `calls`, `set(obj)` (fires storage change), `internals` (from content.js). The fake background scores by text hash, hides ≥ hideCutoff, rewrites with a visible "Calmer take:" prefix. In Claude-in-Chrome, tabs report `document.hidden === true` between tool calls; `__nmsTest.visible()` overrides that.
