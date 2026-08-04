#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Proxytop"
BUILD_DIR="$ROOT/build"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
VERSION="${PROXYTOP_VERSION:-$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_DIR/Contents/Info.plist")}"
DMG="$BUILD_DIR/$APP_NAME-$VERSION.dmg"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

test -d "$APP_DIR" || { echo "missing $APP_DIR; run scripts/build-app.sh first" >&2; exit 1; }

# 1. Build the drag-to-Applications disk image
mkdir -p "$STAGING"
cp -R "$APP_DIR" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "$APP_NAME $VERSION" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null

# 2. Notarize and staple when credentials are present
notarized=0
if [[ -n "${PROXYTOP_NOTARY_KEY_ID:-}" && -n "${PROXYTOP_NOTARY_KEY_ISSUER_ID:-}" && -n "${PROXYTOP_NOTARY_KEY_B64:-}" ]]; then
  KEYFILE="$(mktemp)"
  echo "$PROXYTOP_NOTARY_KEY_B64" | base64 --decode > "$KEYFILE"
  xcrun notarytool submit "$DMG" \
    --key-id "$PROXYTOP_NOTARY_KEY_ID" \
    --issuer-id "$PROXYTOP_NOTARY_KEY_ISSUER_ID" \
    --key "$KEYFILE" \
    --wait
  rm -f "$KEYFILE"
  xcrun stapler staple "$DMG"
  notarized=1
elif [[ -n "${PROXYTOP_APPLE_ID:-}" && -n "${PROXYTOP_APPLE_PASSWORD:-}" && -n "${PROXYTOP_APPLE_TEAM_ID:-}" ]]; then
  xcrun notarytool submit "$DMG" \
    --apple-id "$PROXYTOP_APPLE_ID" \
    --password "$PROXYTOP_APPLE_PASSWORD" \
    --team-id "$PROXYTOP_APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG"
  notarized=1
else
  echo "notarization skipped (no credentials)"
fi

shasum -a 256 "$DMG" > "$DMG.sha256"

echo "Packaged: $DMG (notarized: $notarized)"
echo "SHA256: $(awk '{print $1}' "$DMG.sha256")"
