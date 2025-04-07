// Global variables for API key and cutoff threshold
let apiKey = "";
let inflammatoryCutoff = 0.2; // default cutoff

const EVAL_MODEL = "gpt-4o-mini"; // For quick evaluation
const REWRITE_MODEL = "gpt-4.5-preview"; // For high-quality rewording

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

// Quick local pre-filter patterns (optional)
const quickPatterns = {
  aggressive: /(!|\?){1,}|[A-Z]{2,}|^[^a-z]*$/,
  negative:
    /\b(bad|wrong|hate|stupid|awful|terrible|horrible|dumb|idiot|fail)\b/i,
  extremes:
    /\b(every|always|never|none|all|impossible|definitely|absolutely|literally)\b/i,
  commands: /\b(must|should|need|have to|got to|better|deserve)\b/i,
};

function quickFilter(text) {
  return (
    quickPatterns.aggressive.test(text) ||
    quickPatterns.negative.test(text) ||
    quickPatterns.extremes.test(text) ||
    quickPatterns.commands.test(text)
  );
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

/*
 * Modified isControversial: queries GPT-4 for a controversy score,
 * trims and parses the answer, and then returns an object with both the score
 * and whether it exceeds the cutoff threshold.
 */
async function isControversial(text) {
  if (!text || text.length < 5) {
    return { score: 0.0, isControversial: false };
  }
  if (tweetCache.has(text)) {
    return tweetCache.get(text);
  }
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EVAL_MODEL,
        messages: [
          {
            role: "system",
            content:
              'You are an expert at identifying inflammatory, polarizing, or otherwise unnecessarily negatively-valenced tweets. Consider: 1) controversial/polarizing language, 2) anger/aggression, 3) negativity, 4) hostile tone, 5) extreme language (e.g. swearing, slurs). Read and analyze the tweet, and respond with a score between 0.00 and 1.00 that represents the extent to which the tweet is unnecessarily negative. For example, "Cybertrucks are awesome..." might score 0.05, while a harsh tweet might score 0.9. Respond only with the number.',
          },
          {
            role: "user",
            content: text,
          },
        ],
        max_tokens: 5, // allow a full decimal response
      }),
    });
    const data = await response.json();
    const answer = data.choices[0].message.content.trim();
    const controversyScore = parseFloat(answer);
    const result = {
      score: controversyScore,
      isControversial: controversyScore > inflammatoryCutoff,
    };
    tweetCache.set(text, result);
    return result;
  } catch (error) {
    console.error("Error checking controversy:", error);
    return { score: 0.0, isControversial: false };
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

// Replace the existing processTweet function
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

    // Get controversy data from GPT with retry
    const controversyData = await fetchWithRetry(async () => {
      return await isControversial(tweetText);
    });

    // Create UI container
    const uiContainer = document.createElement("div");
    uiContainer.className = "tweet-ui-container";

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

    if (controversyData.isControversial) {
      try {
        const depolarizedText = await fetchWithRetry(async () => {
          return await getDepolarizedText(tweetText);
        });

        const toggleButton = document.createElement("button");
        toggleButton.className = "toggle-button";
        toggleButton.textContent = "🕊️ Depolarized (show original)";

        const toggleState = new ToggleState(
          textDiv,
          tweetText,
          depolarizedText
        );
        toggleButton.onclick = () => toggleState.toggle();

        // Initially show depolarized version
        toggleState.update();
        leftContainer.appendChild(toggleButton);
        tweetElement.classList.add("depolarized-tweet");
      } catch (error) {
        console.error("Error creating depolarized version:", error);
      }
    }

    // Assemble UI
    uiContainer.appendChild(leftContainer);
    uiContainer.appendChild(rightContainer);

    // Insert UI container
    const tweetActions = tweetElement.querySelector('div[role="group"]');
    if (tweetActions) {
      tweetActions.insertAdjacentElement("beforebegin", uiContainer);
    } else {
      textDiv.parentNode.insertBefore(uiContainer, textDiv.nextSibling);
    }

    tweetElement.setAttribute("data-processed", "true");
  } catch (error) {
    console.error("Error processing tweet:", error);
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
  }

  toggle() {
    this.isShowingOriginal = !this.isShowingOriginal;
    this.update();
  }

  update() {
    this.textDiv.textContent = this.isShowingOriginal
      ? this.originalText
      : this.depolarizedText;
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
      model: REWRITE_MODEL,
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
          model: REWRITE_MODEL,
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
