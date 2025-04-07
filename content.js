// Global variables for API key and cutoff threshold
let apiKey = "";
let inflammatoryCutoff = 0.2; // default cutoff

const EVAL_MODEL = "gpt-4o-mini"; // For quick evaluation
const REWRITE_MODEL = "gpt-4o"; // For high-quality rewording

// Fetch API key and cutoff from storage
chrome.storage.sync.get(["apiKey", "inflammatoryCutoff"], (result) => {
  if (result.apiKey) {
    apiKey = result.apiKey;
  }
  if (result.inflammatoryCutoff !== undefined) {
    inflammatoryCutoff = result.inflammatoryCutoff;
  }
});

// Cache for processed tweets
const tweetCache = new Map();

// Optimize the quick pre-filter patterns
const quickPatterns = {
  aggressive: /(!|\?){2,}|[A-Z]{3,}|^[^a-z]*$/,
  negative:
    /\b(bad|wrong|hate|stupid|awful|terrible|horrible|dumb|idiot|fail|terrible|worst|disgusting|pathetic|ridiculous)\b/i,
  extremes:
    /\b(every|always|never|none|all|impossible|definitely|absolutely|literally|completely|totally)\b/i,
  commands:
    /\b(must|should|need|have to|got to|better|deserve|ought|required)\b/i,
  swear: /\b(fuck|shit|damn|hell|ass|bitch|crap|piss|dick|bastard)\b/i,
};

// Enhanced quick filter with scoring
function quickFilter(text) {
  let score = 0;
  if (quickPatterns.aggressive.test(text)) score += 0.3;
  if (quickPatterns.negative.test(text)) score += 0.2;
  if (quickPatterns.extremes.test(text)) score += 0.2;
  if (quickPatterns.commands.test(text)) score += 0.1;
  if (quickPatterns.swear.test(text)) score += 0.4;

  // Apply a minimum floor score for any text that matches any pattern
  // This ensures we don't have too many false negatives at the low end
  if (score > 0 && score < 0.05) score = 0.05;

  return score;
}

// Preserve the tweet text structure (for later use in swapping content)
function preserveStructure(element) {
  const structure = {
    content: "",
    nodes: [],
  };

  function captureNode(node, depth = 0) {
    // Log node information (optional)
    if (node.nodeType === Node.TEXT_NODE) {
      const startIndex = structure.content.length;
      const text = node.textContent;
      structure.content += text;
      structure.nodes.push({
        type: "text",
        start: startIndex,
        length: text.length,
        originalText: text,
        node: node,
      });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains("toggle-button")) return;
      const isBlock = getComputedStyle(node).display === "block";
      if (
        isBlock ||
        node.tagName === "BR" ||
        node.tagName === "DIV" ||
        node.tagName === "P"
      ) {
        const prevChar = structure.content.slice(-1);
        if (structure.content.length > 0 && prevChar !== "\n") {
          structure.content += "\n";
        }
      }
      for (const child of node.childNodes) {
        captureNode(child, depth + 1);
      }
      if (isBlock && structure.content.slice(-1) !== "\n") {
        structure.content += "\n";
      }
    }
  }

  captureNode(element);
  return structure;
}

// Restore tweet text using preserved structure (if needed)
function restoreStructure(structure, newContent) {
  let currentPos = 0;
  for (const item of structure.nodes) {
    if (item.type === "text") {
      const remainingNewContent = newContent.length - currentPos;
      const lengthToUse = Math.min(item.length, remainingNewContent);
      const portion = newContent.substring(
        currentPos,
        currentPos + lengthToUse
      );
      item.node.textContent = portion;
      currentPos += lengthToUse;
    }
  }
  if (currentPos < newContent.length) {
    console.warn("Warning: Not all new content was placed.");
  }
}

// Enhanced cache with localStorage backup
class EnhancedCache {
  constructor(name, maxSize = 1000, expirationMs = 3600000) {
    this.name = name;
    this.memoryCache = new Map();
    this.maxSize = maxSize;
    this.expirationMs = expirationMs;
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      const stored = localStorage.getItem(this.name);
      if (stored) {
        const parsed = JSON.parse(stored);
        for (const [key, value] of Object.entries(parsed)) {
          if (Date.now() - value.timestamp < this.expirationMs) {
            this.memoryCache.set(key, value);
          }
        }
      }
    } catch (e) {
      console.warn("Failed to load cache from storage:", e);
    }
  }

  saveToStorage() {
    try {
      const toStore = {};
      for (const [key, value] of this.memoryCache.entries()) {
        toStore[key] = value;
      }
      localStorage.setItem(this.name, JSON.stringify(toStore));
    } catch (e) {
      console.warn("Failed to save cache to storage:", e);
    }
  }

  set(key, value) {
    if (this.memoryCache.size >= this.maxSize) {
      const oldestKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(oldestKey);
    }
    this.memoryCache.set(key, {
      value,
      timestamp: Date.now(),
    });
    this.saveToStorage();
  }

  get(key) {
    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (Date.now() - item.timestamp > this.expirationMs) {
      this.memoryCache.delete(key);
      this.saveToStorage();
      return null;
    }
    return item.value;
  }
}

// Initialize enhanced caches
const controversyCache = new EnhancedCache("controversyCache");
const depolarizationCache = new EnhancedCache("depolarizationCache");

// Optimized isControversial function
async function isControversial(text) {
  if (!text || text.length < 5) {
    return { score: 0.0, isControversial: false };
  }

  // Check cache first
  const cached = controversyCache.get(text);
  if (cached) {
    return cached;
  }

  // Quick pre-filter
  const quickScore = quickFilter(text);

  // Increased threshold to reduce false negatives - now anything below 0.05 is skipped
  if (quickScore < 0.05) {
    const result = { score: quickScore, isControversial: false };
    controversyCache.set(text, result);
    return result;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EVAL_MODEL, // Use gpt-4o-mini for evaluation
        messages: [
          {
            role: "system",
            content:
              "Analyze text for inflammatory/polarizing content. Consider negativity, hostility, aggressive tone, polarizing language, anger, extreme claims, and swearing. Score 0.0-1.0, with 0.0 being completely neutral, 0.3 being mildly inflammatory, and 0.7+ for clearly inflammatory content. Even subtle inflammatory content should score at least 0.1-0.2. Respond with number only.",
          },
          {
            role: "user",
            content: text,
          },
        ],
        max_tokens: 5,
        temperature: 0.1,
        top_p: 0.1,
      }),
    });

    const data = await response.json();
    const answer = data.choices[0].message.content.trim();
    let controversyScore = parseFloat(answer);

    // Apply a minimum floor to the API score to avoid extreme low-end calibration issues
    if (controversyScore > 0 && controversyScore < 0.05) {
      controversyScore = 0.05;
    }

    const result = {
      score: Math.max(controversyScore, quickScore),
      isControversial:
        controversyScore > inflammatoryCutoff ||
        quickScore > inflammatoryCutoff,
    };
    controversyCache.set(text, result);
    return result;
  } catch (error) {
    console.error("Error checking controversy:", error);
    return {
      score: quickScore,
      isControversial: quickScore > inflammatoryCutoff,
    };
  }
}

// Add after the existing cache declaration
class TweetQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = 3;
    this.activeRequests = 0;
  }

  async add(tweet) {
    this.queue.push(tweet);
    if (!this.processing) {
      this.processing = true;
      await this.process();
    }
  }

  async process() {
    while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const tweet = this.queue.shift();
      this.activeRequests++;
      try {
        await processTweet(tweet);
      } catch (error) {
        console.error("Error processing tweet:", error);
        // Retry once if failed
        if (!tweet.hasAttribute("data-retried")) {
          tweet.setAttribute("data-retried", "true");
          this.queue.unshift(tweet);
        }
      } finally {
        this.activeRequests--;
      }
    }
    this.processing = this.queue.length > 0;
  }
}

const tweetQueue = new TweetQueue();

// Add loading state management
function createLoadingState() {
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "loading-state";
  loadingDiv.innerHTML = '<div class="spinner"></div>';
  return loadingDiv;
}

// Add function to detect and handle quote-tweets
function isQuoteTweet(tweetElement) {
  return tweetElement.querySelector('[data-testid="tweet"]') !== null;
}

function getOriginalTweetText(tweetElement) {
  const quotedTweet = tweetElement.querySelector('[data-testid="tweet"]');
  if (!quotedTweet) return null;
  const textDiv = quotedTweet.querySelector('[data-testid="tweetText"]');
  return textDiv ? textDiv.textContent.trim() : null;
}

function isSignificantModification(quoteText, originalText) {
  if (!originalText) return true;
  // Remove common quote-tweet prefixes and whitespace
  const cleanQuoteText = quoteText.replace(/^["'`]|["'`]$/g, "").trim();
  const cleanOriginalText = originalText.replace(/^["'`]|["'`]$/g, "").trim();

  // If the quote text is just the original text with some minor modifications
  if (cleanQuoteText === cleanOriginalText) return false;

  // If the quote text contains the original text with just some added context
  if (cleanQuoteText.includes(cleanOriginalText)) return false;

  return true;
}

// Modify the processTweet function to handle loading states better
async function processTweet(tweetElement) {
  if (
    tweetElement.hasAttribute("data-processed") ||
    tweetElement.hasAttribute("data-processing")
  ) {
    return;
  }

  tweetElement.setAttribute("data-processing", "true");

  try {
    // Remove any existing UI container
    const existingUI = tweetElement.querySelector(".tweet-ui-container");
    if (existingUI) existingUI.remove();

    const textDiv = tweetElement.querySelector('[data-testid="tweetText"]');
    if (!textDiv) {
      throw new Error("Tweet text element not found");
    }

    if (!apiKey) {
      throw new Error("API key not set");
    }

    const structure = preserveStructure(textDiv);
    const tweetText = structure.content;

    // Handle quote-tweets
    if (isQuoteTweet(tweetElement)) {
      const originalText = getOriginalTweetText(tweetElement);
      if (!isSignificantModification(tweetText, originalText)) {
        tweetElement.setAttribute("data-processed", "true");
        return;
      }
    }

    // Create UI container with loading state
    const uiContainer = document.createElement("div");
    uiContainer.className = "tweet-ui-container";
    const loadingState = createLoadingState();
    uiContainer.appendChild(loadingState);

    // Insert loading UI immediately
    const tweetActions = tweetElement.querySelector('div[role="group"]');
    if (tweetActions) {
      tweetActions.insertAdjacentElement("beforebegin", uiContainer);
    } else {
      textDiv.parentNode.insertBefore(uiContainer, textDiv.nextSibling);
    }

    // Get controversy score first
    let controversyData = controversyCache.get(tweetText);
    if (!controversyData) {
      controversyData = await fetchWithRetry(async () => {
        return await isControversial(tweetText);
      });
      controversyCache.set(tweetText, controversyData);
    }

    // Create score display
    const scoreButton = document.createElement("button");
    scoreButton.className = "toggle-button score-button";
    scoreButton.textContent = `Inflammation score: ${controversyData.score.toFixed(
      2
    )}`;

    // Create left container for depolarized toggle
    const leftContainer = document.createElement("div");
    leftContainer.className = "left";

    // Create right container for score
    const rightContainer = document.createElement("div");
    rightContainer.className = "right";
    rightContainer.appendChild(scoreButton);

    // If controversial, get depolarized text
    if (controversyData.isControversial) {
      try {
        let depolarizedText = depolarizationCache.get(tweetText);
        if (!depolarizedText) {
          depolarizedText = await fetchWithRetry(async () => {
            return await getDepolarizedText(tweetText);
          });
          depolarizationCache.set(tweetText, depolarizedText);
        }

        const toggleButton = document.createElement("button");
        toggleButton.className = "toggle-button";
        toggleButton.textContent = "🕊️ Depolarized (show original)";

        const toggleState = new ToggleState(
          textDiv,
          tweetText,
          depolarizedText
        );
        toggleState.toggleButton = toggleButton;
        toggleButton.onclick = () => toggleState.toggle();

        // Initially show depolarized version
        toggleState.update();
        leftContainer.appendChild(toggleButton);
        tweetElement.classList.add("depolarized-tweet");
      } catch (error) {
        console.error("Error creating depolarized version:", error);
      }
    }

    // Remove loading state and assemble final UI
    loadingState.remove();
    uiContainer.appendChild(leftContainer);
    uiContainer.appendChild(rightContainer);

    tweetElement.setAttribute("data-processed", "true");
  } catch (error) {
    console.error("Error processing tweet:", error);
    // Remove loading state on error
    const loadingState = tweetElement.querySelector(".loading-state");
    if (loadingState) loadingState.remove();
  } finally {
    tweetElement.removeAttribute("data-processing");
  }
}

// Add helper functions
async function fetchWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i))
      );
    }
  }
}

class ToggleState {
  constructor(textDiv, originalText, depolarizedText) {
    this.textDiv = textDiv;
    this.originalText = originalText;
    this.depolarizedText = depolarizedText;
    this.isShowingOriginal = false;
    this.toggleButton = null;
  }

  toggle() {
    this.isShowingOriginal = !this.isShowingOriginal;
    this.update();
  }

  update() {
    // Update text content
    this.textDiv.textContent = this.isShowingOriginal
      ? this.originalText
      : this.depolarizedText;

    // Update button text if button reference exists
    if (this.toggleButton) {
      this.toggleButton.textContent = this.isShowingOriginal
        ? "🕊️ Original (show depolarized)"
        : "🕊️ Depolarized (show original)";
    }
  }
}

// Replace the existing observer setup
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tweets = node.querySelectorAll(
          'article[data-testid="tweet"]:not([data-processed])'
        );
        tweets.forEach((tweet) => tweetQueue.add(tweet));
      }
    });
  });
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

async function getDepolarizedText(tweetText) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: REWRITE_MODEL, // Use gpt-4o for rewriting
      messages: [
        {
          role: "system",
          content:
            "Rephrase the following text to use more constructive, measured language while preserving the core message. Keep length under 280 characters. Maintain any paragraph breaks. IMPORTANT: Preserve ALL of the original information - do not truncate or omit any of the underlying content. Ensure that the rephrasing is even and calm.",
        },
        {
          role: "user",
          content: tweetText,
        },
      ],
    }),
  });

  const data = await response.json();
  let depolarizedText = data.choices[0].message.content.trim();

  // If the reworded text is over 280 characters, call GPT again for a minimal adjustment
  if (depolarizedText.length > 280) {
    const secondResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: REWRITE_MODEL, // Use gpt-4o for rewriting
          messages: [
            {
              role: "system",
              content:
                "You are an expert at making minimal changes to reduce the length of text while preserving all the original information. The text provided is slightly too long. Please make as few wording edits as possible so that the final version is just under 280 characters, without omitting any important details or core information.",
            },
            {
              role: "user",
              content: depolarizedText,
            },
          ],
          max_tokens: 10,
        }),
      }
    );

    const secondData = await secondResponse.json();
    depolarizedText = secondData.choices[0].message.content.trim();

    // If still too long, trim it
    if (depolarizedText.length > 280) {
      console.warn(
        "Text still too long after second attempt; trimming to 280 characters"
      );
      depolarizedText = depolarizedText.substring(0, 280);
    }
  }

  return depolarizedText;
}

// Add CSS for loading state
const style = document.createElement("style");
style.textContent = `
  .loading-state {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 8px;
  }
  
  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #1da1f2;
    border-radius: 50%;
    border-top-color: transparent;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);
