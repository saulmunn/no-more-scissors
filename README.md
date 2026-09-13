# No More Scissors

Some posts on X make a good point in the most inflammatory way possible. This browser extension scores every post on your timeline for how hostile its *wording* is (0–100), shows the score next to the timestamp, and quietly rewrites any post above a threshold you choose so it says the same thing without the heat. One click shows the original.

It runs on your own API key: OpenAI by default, Anthropic, or any OpenAI-compatible endpoint (including a local Ollama, which is free and keeps everything on your machine). Nothing is sent anywhere except post text to the provider you chose, and nothing is changed on X itself: the rewrite is a local overlay.

_The name is a nod to Scott Alexander's ["Sort by Controversial"](https://slatestarcodex.com/2018/10/30/sort-by-controversial/)._

## What it looks like

- Every post gets a small badge in its header, right after the time: a coloured dot (green → red) and the score, in X's own muted text style. Hover for the one-line reason.
- Posts at or above your **rewrite threshold** show the calmer wording with a thin rule down the left side. Phrases that changed are dotted-underlined, and **Show original** brings the exact wording back.
- Posts at or above the **collapse threshold** (85 by default) fold into a single line, `Hidden · 92 · dehumanizing language`, with **Show anyway**.
- Quoted posts are scored and rewritten inside the quote.
- The compose box shows a live score of what you're about to post. When you reply to a rewritten post, the original wording is shown so you're answering what was actually said.
- Profile pages get an **author heat** pill: that account's average score over the last 30 of their posts you've seen.
- Nothing appears until a post has been scored, so the timeline stays clean. Optionally, posts can be blurred until scored so you never see the original wording flash by.

## Setup

### 1. Get an API key

| Provider | Get a key | Notes |
|---|---|---|
| **OpenAI** (default) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Sign in (or create an account and add a few dollars of credit), click **Create new secret key**. Cheapest option. |
| **Anthropic** | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | Haiku 4.5 scores and Opus 5 rewrites by default; see [Cost](#cost) before picking Opus. |
| **Custom endpoint** | — | Any OpenAI-compatible `/chat/completions` server. For a free, private setup install [Ollama](https://ollama.com), pull a model, and use `http://localhost:11434/v1` with the key left empty. Your browser asks for permission to reach that origin when you enter the URL. |

Copy the key somewhere safe. You won't be shown it again.

### 2. Load the extension

1. Click the green **Code** button on this repo, then **Download ZIP**, and unzip it somewhere you'll keep it.

![image](https://github.com/user-attachments/assets/5a91248c-862c-45af-86d3-ec0791174b6d)

2. In Chrome, click the puzzle-piece icon in the toolbar, then **Manage extensions**:

![image](https://github.com/user-attachments/assets/87c21556-c5e7-4e86-acaa-e4203dc35a1a)

![image](https://github.com/user-attachments/assets/6a201e06-bbc5-4f5a-adc5-8c308b99769f)

3. Turn on **Developer mode** (top right), click **Load unpacked** (top left), and pick the folder you unzipped.

![image](https://github.com/user-attachments/assets/ce82db75-e8af-4cb1-8d3c-0712a1adb084)

![image](https://github.com/user-attachments/assets/103202e3-c568-4ebe-9eed-562618e23591)

**Firefox:** open `about:debugging`, choose **This Firefox**, click **Load Temporary Add-on…**, and pick `manifest.json` inside the unzipped folder. Firefox doesn't grant site permissions at install, so click **Allow access** on the setup page that opens. Temporary add-ons are removed when Firefox quits; load it again next time.

### 3. First-run setup

The extension opens a setup page the first time it's installed:

1. Choose a provider and paste your key. It's checked immediately and saved on your machine only.
2. Pick the rewrite threshold.
3. Click **Open X** and scroll.

You can reopen the page any time from **Setup guide** in the popup.

## Calibrate the scale

The setup page has an optional one-minute step: rate eight example posts as Fine, Snarky, Hostile, Cruel, or Abusive. Your ratings are added to your own scoring prompt, so the numbers match how you read things rather than a generic rubric. The threshold slider then tells you which of your ratings would be rewritten, and once a key is in place you can score eight other posts with the model to see the scale in action. Reach it any time from **Calibrate** in the popup footer; changing your ratings clears cached scores so posts are re-scored on the new scale.

## Settings

Everything lives in the toolbar popup (pin the icon from the puzzle-piece menu).

| Setting | What it does |
|---|---|
| **On/off** | The switch in the popup header pauses the extension without forgetting anything. |
| **Provider and key** | OpenAI, Anthropic, or a custom endpoint, each with its own key. Custom endpoints also take a base URL (no trailing `/chat/completions`). |
| **Rewrite posts scoring …** | Posts at or above this score get rewritten. 40 is the default (clearly hostile or contemptuous posts). Around 25 also catches snark; 70+ leaves everything but insults and rage bait alone. Changing it re-evaluates posts already on screen. |
| **Collapse posts scoring …** | Posts at or above this score fold into one line with the score and reason. 85 by default; set it to "never" to rewrite everything instead. |
| **Score every post** | Off: badges only appear on rewritten and collapsed posts. |
| **Blur posts until scored** | Blurs each post's text for the second or so it takes to score it, so you never see the original wording of a post that's about to be rewritten. |
| **Models** | Every post is scored with the cheap, fast model; only posts above the threshold are rewritten, so the rewrite uses a better one. Defaults: `gpt-5.4-nano` / `gpt-5.4-mini` (OpenAI), `claude-haiku-4-5` / `claude-opus-5` (Anthropic). Any model id can be typed in. |
| **Rewrite style** | **Light** changes as few words as possible. **Neutral** (default) removes the contempt and keeps everything else. **Kind** also assumes good faith and phrases disagreement generously. **Custom** takes your own instruction. Changing the style regenerates rewrites. |
| **Monthly spend cap** | Stops calling the API once the month's estimated spend reaches this amount. $10 by default; 0 means no cap. |

The popup also shows how many posts have been scored and rewritten, this month's estimated cost, and the last error, if any.

### Toolbar badge

| Badge | Meaning |
|---|---|
| a number | Posts rewritten or collapsed on the current tab |
| `!` (red) | No key for the chosen provider, or the last request was rejected as an invalid key |
| `$` (amber) | The monthly spend cap has been reached; nothing more is sent until next month or until you raise the cap |

## How scoring works

The model is asked to rate the tone and framing, not the topic, on this scale:

| Score | Wording |
|---|---|
| 0–19 | neutral, friendly, informational, or earnest, even if strongly opinionated |
| 20–39 | pointed or sarcastic; some snark or frustration, but no contempt for people |
| 40–59 | clearly hostile or contemptuous toward a person or group; sneering; "these people" framing |
| 60–79 | aggressive: insults, name-calling, dehumanizing language, us-vs-them rage bait |
| 80–100 | slurs, threats, calls for harm, or maximal contempt |

Posts are sent up to 8 per call, and the scoring prompt carries a long set of calibration examples that the provider caches, so each post adds only a few dozen tokens.

Rewrites are instructed to keep every claim, opinion, and joke, the author's voice and register, all mentions, hashtags, links, and line breaks, and to never be longer than the original. They only remove the contempt. If the model thinks a post is already calm it returns it unchanged, and the extension leaves it alone.

## Cost

Scores and rewrites are cached on your machine, so scrolling past the same post twice, or reloading, costs nothing. Rough figures with the default OpenAI models:

| | Tokens per post | Cost per post | Per 1,000 posts |
|---|---|---|---|
| Score (every post; `gpt-5.4-nano`) | ~60 in (amortised over the batch and the cached prompt), ~20 out | ~$0.00003 | ≈ $0.03 |
| Rewrite (flagged posts only; `gpt-5.4-mini`) | ~500 in, ~80 out | ~$0.0007 | $0.74 |

A heavy day of scrolling with a fifth of posts flagged is a few cents.

With the Anthropic defaults, scoring on Haiku 4.5 ($1 / $5 per 1M tokens) is about $0.16 per 1,000 posts, and rewriting on Opus 5 ($5 / $25 per 1M) is about $4.50 per 1,000 flagged posts, roughly 6–7× the OpenAI rewrite cost. Sonnet 5 ($2 / $10) is the cheaper alternative at about $1.80 per 1,000 rewrites; pick it in the popup's Models section.

The monthly spend cap (default $10) is an estimate computed from token counts and the price table above; unknown model ids are estimated at $1 / $5 per 1M and marked as such in the popup.

## Privacy

- Your API key is stored with `chrome.storage.local` on this computer. It is not synced and never leaves the extension's background worker except as the authorization header to the provider that issued it.
- The only data sent anywhere is the text of posts on your timeline (and your draft in the compose box), to the provider you chose, under your own account.
- Nothing is posted, liked, or changed on X. The rewrite is a local overlay; the original post is still in the page and one click brings it back.
- Nothing is sent to the extension's author. The full policy is in [PRIVACY.md](PRIVACY.md).

## Known limitations

- Posts are scored after they appear, so without the blur option you may glimpse the original for a moment.
- The rewrite is plain text with links restored for mentions, hashtags, and URLs. Anything more exotic in the original (cashtags, emoji rendered as images) shows up as plain characters.
- Long posts that X truncates with "Show more" are scored on the visible part.
- Custom endpoints need a model that can return JSON; the extension falls back from strict schemas to plain JSON, but very small local models sometimes still wander.
- X changes its markup now and then. If badges stop appearing, the selectors at the top of `content/content.js` are the first place to look.

## Development

```
node scripts/bg-test.js               # background.js unit test with a fake chrome + fetch
scripts/build-test-bundle.sh out.js   # shim + CSS + content scripts in one file to paste into an x.com console
scripts/package.sh                    # dist/no-more-scissors-<version>.zip for the Web Store / AMO
python3 scripts/make-promo.py         # placeholder store art in store/
python3 scripts/make-icons.py         # regenerates icons/ with Pillow
```

The test bundle fakes the background worker with deterministic scores, so the timeline UI can be checked without an API key or an installed extension. On an unpacked install, `window.postMessage({ type: 'nms-dev-reload' }, '*')` from an x.com console reloads the extension. `docs/architecture.md` is the contract between the pieces: settings keys, message shapes, providers, and prices.
