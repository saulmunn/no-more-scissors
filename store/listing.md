# Chrome Web Store listing — No More Scissors

Everything below is ready to paste into the developer dashboard. Items marked **TODO** need the owner.

## Name

No More Scissors

## Summary (≤ 132 characters)

Scores every post on X for hostile wording and calmly rewords the ones above your threshold. Uses your own OpenAI or Anthropic key.

## Detailed description

Some posts on X make a good point in the most inflammatory way possible. No More Scissors scores every post on your timeline for how hostile its wording is, on a 0 to 100 scale, and shows the score as a small badge next to the timestamp. Posts above a threshold you choose are quietly rewritten so they say the same thing without the heat: every claim, opinion and joke stays, the author's voice stays, only the contempt goes. The original is always one click away.

It runs on your own API key. OpenAI is the default; Anthropic and any OpenAI-compatible endpoint (including a local Ollama server, which costs nothing and keeps everything on your machine) also work. Post text is sent to the provider you chose and nowhere else. There is no server behind the extension and nothing is ever posted, liked, or changed on X: the rewrite is a local overlay.

The scale is simple. 0 to 19 is neutral or earnest, even if strongly opinionated. 20 to 39 is pointed or snarky. 40 to 59 is hostile or contemptuous toward people. 60 to 79 is insults, dehumanizing language and rage bait. 80 and up is slurs, threats and calls for harm. Only tone and framing are judged, never the topic.

You set two lines. Posts at or above the rewrite threshold (40 by default) are reworded. Posts at or above the collapse threshold (85 by default) are folded into a single line with the score and a short reason, with a Show anyway link. Changed phrases are dotted-underlined so you can see what moved, and Show original brings back the exact wording. Quoted posts are handled too, the compose box shows a live score of what you are about to post, and replying to a rewritten post shows you the original first.

Costs are small. Posts are scored in batches with a cached prompt, so a thousand posts cost a few cents with the default OpenAI models; rewrites, which only happen for flagged posts, are under a dollar per thousand. Scores and rewrites are cached on your machine, and a monthly spend cap ($10 by default) stops the extension before a surprise bill.

Requires an API key from OpenAI, Anthropic, or a compatible provider. Not affiliated with X.

## Category

**Social Media & Communication** (older dashboards call it "Social & Communication"). The extension changes how a social feed reads, and that is where people looking for X/Twitter tools browse. "Productivity" is the alternative, but it would sit next to tab managers and to-do lists rather than next to the timeline tools it competes with.

## Language

English

## Single purpose

Scores posts on X for inflammatory wording and shows a calmer rewrite of the ones above a user-chosen threshold.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Stores the user's API key, settings, a local cache of scores and rewrites, per-author score history, and usage counters on the user's computer. |
| `https://x.com/*`, `https://twitter.com/*` | Reads the text of posts on the timeline so they can be scored, and overlays the score badge and the rewritten text on the page. Nothing is posted or changed on X. |
| `https://api.openai.com/*` | Sends post text to OpenAI under the user's own API key to score it and, above the threshold, rewrite it. |
| `https://api.anthropic.com/*` | Same as above, for users who choose Anthropic as their provider. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | Requested only when the user enters a custom OpenAI-compatible endpoint (for example a local Ollama server), and only for that one origin, so the extension can send post text there instead of to OpenAI or Anthropic. Never requested otherwise. |

Remote code: none. All code ships in the package; the extension only exchanges JSON with the user's chosen API.

## Privacy practices (data usage disclosure)

Data types the extension collects or handles:

- **Website content**: yes. The text of posts on the user's X timeline (and the user's draft in the compose box) is sent to the AI provider the user configured, under the user's own account, to score and rewrite it.
- **Authentication information**: yes. The user's API key is stored locally in `chrome.storage.local` and sent only to the provider that issued it, as the authorization header on those requests. It is never sent anywhere else.
- **Personal communications**: post text can be read as social media posts; declare it if the reviewer asks, otherwise "Website content" covers it.
- Personally identifiable information, health, financial and payment information, location, web history, user activity: no.

Certifications (all true):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

Raw: `https://raw.githubusercontent.com/saulmunn/no-more-scissors/main/PRIVACY.md`
Rendered (nicer for reviewers): `https://github.com/saulmunn/no-more-scissors/blob/main/PRIVACY.md`

**TODO**: confirm the branch name and that the repo is public before pasting.

## Assets

| File | Use |
|---|---|
| `store/screenshot-1280x800.png` | Screenshot (placeholder mock; replace) |
| `store/promo-tile-440x280.png` | Small promo tile |
| `store/marquee-1400x560.png` | Marquee promo tile |
| `icons/icon128.png` | Store icon |

Regenerate with `python3 scripts/make-promo.py`. Build the upload with `scripts/package.sh` (writes `dist/no-more-scissors-<version>.zip`).

## Before submitting (owner checklist)

- [ ] Take one to five real screenshots (1280×800 or 640×400) from an actual timeline: a badge, a rewritten post with Show original, a collapsed post, the popup, the setup page. Blur or pick posts you are comfortable showing. Replace `store/screenshot-1280x800.png`.
- [ ] Decide which Google account publishes this, register it as a Chrome Web Store developer, and pay the one-time $5 registration fee.
- [ ] Push `PRIVACY.md` and confirm the privacy policy URL above resolves.
- [ ] Run `scripts/package.sh` and upload the zip from `dist/`.
- [ ] Fill in the privacy practices tab with the answers above and tick the three certifications.
- [ ] Optionally add a support URL (`https://github.com/saulmunn/no-more-scissors/issues`) and a homepage.
- [ ] Firefox (optional): the manifest already carries `browser_specific_settings.gecko` with `data_collection_permissions`; submit the same zip at addons.mozilla.org.
