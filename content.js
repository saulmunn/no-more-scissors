// Global variables for API key and cutoff threshold
let apiKey = "";
let inflammatoryCutoff = 0.2; // default cutoff

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
        model: "gpt-4",
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

/*
 * Process each tweet element:
 * - Preserves tweet text and gets controversy data.
 * - If inflammatory, fetches the depolarized text and creates a toggle button.
 * - Creates a UI container (displayed as a flex row) inserted between tweet content and tweet actions.
 *   The left side contains the depolarized toggle (if available) and the right side displays the inflammation score.
 */
async function processTweet(tweetElement) {
  if (
    tweetElement.hasAttribute("data-processed") ||
    tweetElement.hasAttribute("data-processing")
  )
    return;
  tweetElement.setAttribute("data-processing", "true");

  // Remove any existing UI container (if reprocessing)
  const existingUI = tweetElement.querySelector(".tweet-ui-container");
  if (existingUI) existingUI.remove();

  const textDiv = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textDiv) {
    tweetElement.removeAttribute("data-processing");
    return;
  }
  if (!apiKey) {
    tweetElement.removeAttribute("data-processing");
    return;
  }

  const structure = preserveStructure(textDiv);
  const tweetText = structure.content;

  // Get controversy data from GPT
  const controversyData = await isControversial(tweetText);

  if (controversyData.isControversial) {
    try {
      // First call to get the reworded text.
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4-0125-preview",
            messages: [
              {
                role: "system",
                content:
                  "Rephrase the following text to use more constructive, measured language while preserving the core message. Keep length under 280 characters. Maintain any paragraph breaks. IMPORTANT: Preserve ALL of the original information - do not truncate or omit any details.",
              },
              {
                role: "user",
                content: tweetText,
              },
            ],
          }),
        }
      );
      const data = await response.json();
      let depolarizedText = data.choices[0].message.content.trim();

      // If the reworded text is over 280 characters, call GPT again for a minimal adjustment.
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
              model: "gpt-4-0125-preview",
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
              max_tokens: 10, // Adjust if necessary
            }),
          }
        );
        const secondData = await secondResponse.json();
        let newDepolarizedText = secondData.choices[0].message.content.trim();

        // If it’s still over 280 characters, you might want to loop or fall back to trimming.
        if (newDepolarizedText.length > 280) {
          console.warn(
            "Second attempt still too long; trimming to 280 characters."
          );
          newDepolarizedText = newDepolarizedText.substring(0, 280);
        }
        depolarizedText = newDepolarizedText;
      }

      console.log("Original text:", tweetText);
      console.log("Final depolarized text:", depolarizedText);

      // Create the toggle button using the final depolarized text.
      const toggleButton = document.createElement("button");
      toggleButton.className = "toggle-button";
      toggleButton.textContent = "🕊️ Depolarized (show original)";

      const showOriginal = () => {
        while (textDiv.firstChild) {
          textDiv.removeChild(textDiv.firstChild);
        }
        textDiv.textContent = tweetText;
        toggleButton.textContent = "Show depolarized version";
      };

      const showDepolarized = () => {
        while (textDiv.firstChild) {
          textDiv.removeChild(textDiv.firstChild);
        }
        textDiv.textContent = depolarizedText;
        toggleButton.textContent = "🕊️ Depolarized (show original)";
      };

      let isShowingOriginal = false;
      toggleButton.onclick = () => {
        isShowingOriginal = !isShowingOriginal;
        if (isShowingOriginal) {
          showOriginal();
        } else {
          showDepolarized();
        }
      };

      // Initially display the depolarized version.
      showDepolarized();
      leftContainer.appendChild(toggleButton);
      tweetElement.classList.add("depolarized-tweet");
    } catch (error) {
      console.error("Error processing tweet:", error);
    }
  }

  // Create the main UI container with flex layout
  const uiContainer = document.createElement("div");
  uiContainer.className = "tweet-ui-container";

  // Left container for the depolarized toggle button
  const leftContainer = document.createElement("div");
  leftContainer.className = "left";
  // Right container for the inflammation score
  const rightContainer = document.createElement("div");
  rightContainer.className = "right";

  // If the tweet is inflammatory, fetch and display the depolarized text toggle button
  if (controversyData.isControversial) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4-0125-preview",
            messages: [
              {
                role: "system",
                content:
                  "Rephrase the following text to use more constructive, measured language while preserving the core message. Keep length under 280 characters. Maintain any paragraph breaks. IMPORTANT: Preserve ALL of the original information - do not truncate or omit any details.",
              },
              {
                role: "user",
                content: tweetText,
              },
            ],
          }),
        }
      );
      const data = await response.json();
      const depolarizedText = data.choices[0].message.content;
      if (depolarizedText.length <= 280) {
        const toggleButton = document.createElement("button");
        toggleButton.className = "toggle-button";
        toggleButton.textContent = "🕊️ Depolarized (show original)";
        const showOriginal = () => {
          while (textDiv.firstChild) {
            textDiv.removeChild(textDiv.firstChild);
          }
          textDiv.textContent = tweetText;
          toggleButton.textContent = "Show depolarized version";
        };
        const showDepolarized = () => {
          while (textDiv.firstChild) {
            textDiv.removeChild(textDiv.firstChild);
          }
          textDiv.textContent = depolarizedText;
          toggleButton.textContent = "🕊️ Depolarized (show original)";
        };
        let isShowingOriginal = false;
        toggleButton.onclick = () => {
          isShowingOriginal = !isShowingOriginal;
          if (isShowingOriginal) {
            showOriginal();
          } else {
            showDepolarized();
          }
        };
        // Initial state: show depolarized version
        showDepolarized();
        leftContainer.appendChild(toggleButton);
        tweetElement.classList.add("depolarized-tweet");
      }
    } catch (error) {
      console.error("Error processing tweet:", error);
    }
  }

  // Create and append the inflammation score button to the right container
  const scoreButton = document.createElement("button");
  scoreButton.className = "toggle-button score-button";
  scoreButton.textContent =
    "Inflammation score: " + controversyData.score.toFixed(2);
  rightContainer.appendChild(scoreButton);

  // Append left and right containers into the UI container
  uiContainer.appendChild(leftContainer);
  uiContainer.appendChild(rightContainer);

  // Insert the UI container between the tweet content and the tweet actions.
  // Try to find the tweet actions container (commonly with role="group")
  const tweetActions = tweetElement.querySelector('div[role="group"]');
  if (tweetActions) {
    tweetActions.insertAdjacentElement("beforebegin", uiContainer);
  } else {
    // If not found, insert after the tweet text container
    textDiv.parentNode.insertBefore(uiContainer, textDiv.nextSibling);
  }

  tweetElement.setAttribute("data-processed", "true");
  tweetElement.removeAttribute("data-processing");
}

// Observer to catch dynamically loaded tweets
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tweets = node.querySelectorAll('article[data-testid="tweet"]');
        tweets.forEach(processTweet);
      }
    });
  });
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});
