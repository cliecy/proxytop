#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Proxytop"
BUILD_DIR="$ROOT/build"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
VERSION="${PROXYTOP_VERSION:-$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$ROOT/app/Resources/Info.plist")}"
VERSION="${VERSION#v}"
SIGN_IDENTITY="${PROXYTOP_SIGN_IDENTITY:--}"

# 1. Engine: single-file Bun executable (headless daemon mode)
bun build --compile --outfile "$BUILD_DIR/proxytop-daemon" "$ROOT/src/index.ts"
test -x "$BUILD_DIR/proxytop-daemon"

# 2. Swift menu bar shell
cd "$ROOT/app"
swift build -c release
SWIFT_BIN="$(swift build -c release --show-bin-path)/$APP_NAME"
test -x "$SWIFT_BIN"

# 3. Assemble the .app bundle
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$SWIFT_BIN" "$APP_DIR/Contents/MacOS/$APP_NAME"
cp "$BUILD_DIR/proxytop-daemon" "$APP_DIR/Contents/Resources/proxytop"
cp "$ROOT/app/Resources/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$ROOT/app/Resources/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP_DIR/Contents/Info.plist"

# 4. Code signing. A real Developer ID identity enables hardened runtime and
#    is required for notarization. Without one we fall back to ad-hoc.
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
else
  codesign --force --options runtime --sign "$SIGN_IDENTITY" "$APP_DIR/Contents/Resources/proxytop"
  codesign --force --options runtime --sign "$SIGN_IDENTITY" "$APP_DIR"
  codesign --verify --deep --strict "$APP_DIR"
fi

echo "Built: $APP_DIR (version $VERSION, identity: ${SIGN_IDENTITY:0:40})"
echo "Run: open \"$APP_DIR\""
