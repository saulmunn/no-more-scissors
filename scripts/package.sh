#!/usr/bin/env bash
# Builds dist/no-more-scissors-<version>.zip with only the files the extension ships.
# Refuses to package if any JS file fails `node --check`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

command -v node >/dev/null || { echo "package.sh: node is required (for node --check)" >&2; exit 1; }
command -v zip  >/dev/null || { echo "package.sh: zip is required" >&2; exit 1; }

version="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"

# Exactly what goes in the zip. Everything else (scripts/, docs/, store/, README, .git) stays out.
include=(manifest.json background.js content popup onboarding icons)
for p in "${include[@]}"; do
  [ -e "$p" ] || { echo "package.sh: missing $p" >&2; exit 1; }
done

# Syntax-check every shipped JS file before packaging.
status=0
while IFS= read -r -d '' f; do
  if ! node --check "$f" 2>/tmp/nms-check.$$; then
    echo "package.sh: syntax error in $f" >&2
    cat /tmp/nms-check.$$ >&2
    status=1
  fi
done < <(find background.js content popup onboarding -name '*.js' -print0)
rm -f /tmp/nms-check.$$
[ "$status" -eq 0 ] || { echo "package.sh: refusing to package" >&2; exit 1; }

mkdir -p dist
out="dist/no-more-scissors-${version}.zip"
rm -f "$out"
zip -q -r -X "$out" "${include[@]}" -x '*.DS_Store' -x '*/.*'

bytes="$(wc -c < "$out" | tr -d ' ')"
files="$(unzip -l "$out" | tail -1 | awk '{print $2}')"
echo "$out ($(( (bytes + 1023) / 1024 )) KB, $files files)"
