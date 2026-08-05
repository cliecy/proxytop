# Reference copy of the Homebrew cask. The published cask is `proxytop-app`
# in the cliecy/tap tap: https://github.com/cliecy/homebrew-tap
#   brew tap cliecy/tap
#   brew install --cask cliecy/tap/proxytop-app
#
# It is named `proxytop-app` to avoid colliding with the `proxytop` formula in
# the same tap (a formula and cask with the same name break brew's audit).
#
# Note: the app is currently unsigned, so the first launch after install is
# blocked by Gatekeeper. Open once with right-click -> Open, or run:
#   xattr -dr com.apple.quarantine "/Applications/Proxytop.app"
cask "proxytop-app" do
  version "1.4.0"
  sha256 "41fd8b20755dd552fa0545b4bb07167a8e97bfdec4db40f7a9db8e86d7afbd0b"

  url "https://github.com/cliecy/proxytop/releases/download/v#{version}/Proxytop-#{version}.dmg",
      verified: "github.com/cliecy/proxytop/"
  name "Proxytop"
  desc "macOS proxy, VPN, and per-application network path inspector"
  homepage "https://github.com/cliecy/proxytop"

  app "Proxytop.app"

  uninstall quit: "com.proxytop.app"

  zap trash: [
    "~/Library/Application Support/Proxytop",
    "~/.config/proxytop",
  ]
end
