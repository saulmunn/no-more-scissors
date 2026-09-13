# Privacy policy — No More Scissors

_Last updated: 2026-09-13_

No More Scissors is a browser extension that scores posts on X for inflammatory wording and shows a calmer rewrite of the ones above a threshold you choose. It has no server of its own.

## What is sent, and where

- **Post text** (the words of posts on your timeline, quoted posts, and the draft in the compose box) is sent to the AI provider you configured, and nowhere else: OpenAI (`api.openai.com`), Anthropic (`api.anthropic.com`), or a custom OpenAI-compatible endpoint you entered yourself (for example a local Ollama server, in which case nothing leaves your machine).
- Requests go to the provider under **your own API key** and are covered by that provider's privacy policy and data-retention terms.
- No account names, profile data, cookies, browsing history, or anything else about you is sent. Post text is sent without the author's name; the author's handle is used only locally for the author heat feature.

## What is stored on your computer

All of this lives in the extension's local storage (`chrome.storage.local`) on the computer where the extension is installed. It is not synced to a browser account.

- Your API key(s) and the custom endpoint URL, if any.
- Your settings (thresholds, models, rewrite style, spend cap, and so on).
- A cache of scores and rewrites, keyed by a hash of the post text, so the same post is never paid for twice.
- Per-author score history: the scores of the last 30 posts you have seen from each account, used for the author heat pill on profile pages.
- Usage counters: how many posts were scored and rewritten, tokens used per model, and the resulting cost estimate.

## What the extension's author receives

Nothing. There is no telemetry, no analytics, no crash reporting, and no server operated by the author. The author never sees your key, your posts, or your settings.

## Deleting your data

- **Clear cache** in the toolbar popup deletes cached scores, rewrites, and author history.
- Removing the extension deletes everything it stored.
- Data already sent to your AI provider is governed by that provider; see their account settings for retention and deletion.

## Changes

If this policy changes, the update is committed to this repository with the date above.

## Contact

Questions or concerns: open an issue at <https://github.com/saulmunn/no-more-scissors/issues>.
