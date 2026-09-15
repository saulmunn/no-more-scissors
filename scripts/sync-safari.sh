#!/bin/bash
# Refreshes safari/extension/ (the folder the Xcode project references) with the shipped extension
# files. Run it after editing the extension, then build the app in Xcode or with xcodebuild.
set -e
cd "$(dirname "$0")/.."
DEST=safari/extension
rm -rf "$DEST"
mkdir -p "$DEST"
cp manifest.json background.js "$DEST/"
cp -R content popup onboarding icons "$DEST/"
echo "synced $(find "$DEST" -type f | wc -l | tr -d ' ') files into $DEST"
