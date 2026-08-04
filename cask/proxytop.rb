# Template for the Homebrew cask. After a release, replace `sha256` with the
# value printed by scripts/package-dmg.sh (also in the .dmg.sha256 asset).
#
# Install with a local tap:
#   brew tap cliecy/proxytop git@github.com:cliecy/homebrew-proxytop.git
#   brew install --cask proxytop
#
# Or submit this file to homebrew-cask as Casks/p/proxytop.rb.
cask "proxytop" do
  version "1.2.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

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
