// When the popup loads, retrieve saved values for API key and cutoff
document.addEventListener("DOMContentLoaded", function () {
  chrome.storage.sync.get(["apiKey", "inflammatoryCutoff"], (result) => {
    if (result.apiKey) {
      document.getElementById("apiKey").value = result.apiKey;
    }
    if (result.inflammatoryCutoff !== undefined) {
      document.getElementById("cutoff").value = result.inflammatoryCutoff;
      document.getElementById("cutoffValue").textContent = parseFloat(
        result.inflammatoryCutoff
      ).toFixed(2);
    } else {
      // Use default cutoff if none exists
      document.getElementById("cutoff").value = 0.2;
      document.getElementById("cutoffValue").textContent = "0.20";
    }
  });
});

// Update the cutoff value display as the slider moves
document.getElementById("cutoff").addEventListener("input", () => {
  const cutoff = document.getElementById("cutoff").value;
  document.getElementById("cutoffValue").textContent =
    parseFloat(cutoff).toFixed(2);
});

// Save both API key and inflammatory cutoff when clicking "Save"
document.getElementById("save").addEventListener("click", () => {
  const apiKey = document.getElementById("apiKey").value;
  const inflammatoryCutoff = parseFloat(
    document.getElementById("cutoff").value
  );
  chrome.storage.sync.set({ apiKey, inflammatoryCutoff }, () => {
    alert("Settings saved!");
  });
});
