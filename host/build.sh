#!/bin/sh
# Builds "X to Reminders.app", the small helper the extension talks to.
# SIGN_IDENTITY="Developer ID Application: ..." signs it with your certificate
# (macOS then keeps the Reminders permission across updates); the default is an
# ad-hoc signature, which works the same but asks for permission again after a rebuild.
set -eu
cd "$(dirname "$0")"
OUT="build"
APP="$OUT/X to Reminders.app"
BIN="x-to-reminders-host"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
for arch in arm64 x86_64; do
  xcrun swiftc -O -parse-as-library -swift-version 5 \
    -target "$arch-apple-macos12.0" \
    -o "$OUT/$BIN-$arch" Sources/Host.swift \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
done
lipo -create -output "$APP/Contents/MacOS/$BIN" "$OUT/$BIN-arm64" "$OUT/$BIN-x86_64"
rm "$OUT/$BIN-arm64" "$OUT/$BIN-x86_64"
codesign --force --timestamp=none --sign "${SIGN_IDENTITY:--}" "$APP"
codesign --verify --strict "$APP"
echo "Built $APP"
