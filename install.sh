#!/bin/sh
# Installs the helper that lets the X to Reminders extension add reminders,
# and registers it with every Chromium-based browser on this Mac.
#   ./install.sh
#   SIGN_IDENTITY="Developer ID Application: …" ./install.sh   (sign with your own certificate)
#   XTR_BROWSER_DIR="/path/to/browser/profile/root" ./install.sh   (a browser this script does not know)
#   XTR_APP="/path/to/X to Reminders.app" ./install.sh   (use a helper you already built)
set -eu
ROOT=$(cd "$(dirname "$0")" && pwd)
NAME="X to Reminders"
HOST_ID="studio.starck.x_to_reminders"
EXTENSION_ID="nehjlchbbfifoofocofjomhmabnijohb"
DEST="$HOME/Library/Application Support/$NAME"
BIN="$DEST/$NAME.app/Contents/MacOS/x-to-reminders-host"
SUPPORT="$HOME/Library/Application Support"

[ "$(uname)" = Darwin ] || { echo "X to Reminders needs macOS, where Apple Reminders lives."; exit 1; }
[ -n "${XTR_APP:-}" ] || xcrun --find swiftc >/dev/null 2>&1 || { echo "The Swift compiler is missing. Run: xcode-select --install"; exit 1; }

APP="${XTR_APP:-$ROOT/host/build/$NAME.app}"
if [ -z "${XTR_APP:-}" ]; then
  echo "Building the helper…"
  sh "$ROOT/host/build.sh" >/dev/null
fi
mkdir -p "$DEST"
rm -rf "$DEST/$NAME.app"
cp -R "$APP" "$DEST/"
"$BIN" --version >/dev/null || { echo "The helper does not run on this Mac."; exit 1; }
echo "  installed in $DEST"

ORIGINS="\"chrome-extension://$EXTENSION_ID/\""
for id in ${XTR_EXTRA_EXTENSION_IDS:-}; do ORIGINS="$ORIGINS, \"chrome-extension://$id/\""; done

register() {
  mkdir -p "$1/NativeMessagingHosts"
  cat > "$1/NativeMessagingHosts/$HOST_ID.json" <<JSON
{
  "name": "$HOST_ID",
  "description": "X to Reminders: adds the posts you pick on X to Apple Reminders",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
}

echo "Registering it with your browsers…"
found=0
for dir in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Chromium" \
  "BraveSoftware/Brave-Browser" "BraveSoftware/Brave-Browser-Beta" "BraveSoftware/Brave-Browser-Nightly" \
  "Microsoft Edge" "Microsoft Edge Beta" "Microsoft Edge Dev" "Microsoft Edge Canary" "Vivaldi" \
  "Arc/User Data" "net.imput.helium" "Thorium" "Comet" "Dia/User Data" "Yandex/YandexBrowser"; do
  [ -d "$SUPPORT/$dir" ] || continue
  register "$SUPPORT/$dir"
  echo "  ✓ $dir"
  found=$((found + 1))
done
if [ -n "${XTR_BROWSER_DIR:-}" ]; then
  register "$XTR_BROWSER_DIR"
  echo "  ✓ $XTR_BROWSER_DIR"
  found=$((found + 1))
fi
[ "$found" -gt 0 ] || echo "  No Chromium browser found. Run again with XTR_BROWSER_DIR set to your browser's folder in Application Support."

cat <<EOF

Last step, in your browser:
  1. Open chrome://extensions and turn on Developer mode.
  2. Click "Load unpacked" and choose: $ROOT/extension
  3. Open x.com and click the new button beside Bookmark on any post.
     The first time, macOS asks once for access to Reminders.
EOF
