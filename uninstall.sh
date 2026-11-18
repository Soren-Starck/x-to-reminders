#!/bin/sh
# Removes the helper and its browser registrations. Your reminders are not touched.
set -eu
NAME="X to Reminders"
HOST_ID="studio.starck.x_to_reminders"
SUPPORT="$HOME/Library/Application Support"
find "$SUPPORT" -maxdepth 4 -path "*/NativeMessagingHosts/$HOST_ID.json" -print -delete 2>/dev/null || true
rm -rf "$SUPPORT/$NAME"
echo "Removed the helper. Remove the extension itself from chrome://extensions."
echo "To also forget the Reminders permission: tccutil reset Reminders studio.starck.x-to-reminders.host"
