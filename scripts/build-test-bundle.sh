#!/bin/bash
# Builds one JS file (fake chrome shim + injected CSS + all content scripts, in manifest order)
# to paste into the console of a logged-in x.com tab for testing without installing the extension.
set -e
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/nms-bundle.js}"
{
  cat scripts/test-shim.js
  node -e 'const fs=require("fs");const css=["content/content.css","content/extras.css"].map(f=>fs.readFileSync(f,"utf8")).join("\n");console.log("(()=>{const s=document.createElement(\"style\");s.id=\"nms-test-style\";s.textContent="+JSON.stringify(css)+";document.head.appendChild(s);})();")'
  cat content/common.js content/content.js content/composer.js content/profile.js
} > "$OUT"
node --check "$OUT"
echo "bundle: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
