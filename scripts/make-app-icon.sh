#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/render.swift" <<'SWIFT'
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

let background = NSBezierPath(
  roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
  xRadius: 220,
  yRadius: 220
)
NSColor(calibratedRed: 0.024, green: 0.043, blue: 0.055, alpha: 1).setFill()
background.fill()

let teal = NSColor(calibratedRed: 0.22, green: 0.74, blue: 0.83, alpha: 1)
let line = NSBezierPath()
line.lineWidth = 52
line.lineCapStyle = .round
line.lineJoinStyle = .round
let points = [
  NSPoint(x: 330, y: 320),
  NSPoint(x: 694, y: 320),
  NSPoint(x: 512, y: 690),
]
line.move(to: points[0])
line.line(to: points[1])
line.line(to: points[2])
line.close()
teal.setStroke()
line.stroke()

let inner = NSBezierPath()
inner.lineWidth = 18
inner.move(to: points[0])
inner.line(to: points[1])
inner.line(to: points[2])
inner.close()
NSColor(calibratedRed: 0.85, green: 0.95, blue: 0.97, alpha: 1).setStroke()
inner.stroke()

teal.setFill()
for point in points {
  NSBezierPath(
    ovalIn: NSRect(x: point.x - 88, y: point.y - 88, width: 176, height: 176)
  ).fill()
}

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fatalError("failed to render icon")
}
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
SWIFT

ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
swift "$TMP/render.swift" "$TMP/icon-1024.png"

sips -z 16 16 "$TMP/icon-1024.png" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$TMP/icon-1024.png" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$TMP/icon-1024.png" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$TMP/icon-1024.png" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$TMP/icon-1024.png" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$TMP/icon-1024.png" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$TMP/icon-1024.png" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$TMP/icon-1024.png" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$TMP/icon-1024.png" --out "$ICONSET/icon_512x512.png" >/dev/null
cp "$TMP/icon-1024.png" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ROOT/app/Resources/AppIcon.icns"
echo "Generated: $ROOT/app/Resources/AppIcon.icns"
