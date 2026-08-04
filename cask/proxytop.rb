# Install with a local tap:
#   brew tap cliecy/proxytop git@github.com:cliecy/homebrew-proxytop.git
#   brew install --cask proxytop
#
# Or submit this file to homebrew-cask as Casks/p/proxytop.rb.
#
# Note: the app is currently unsigned, so the first launch after install is
# blocked by Gatekeeper. Open once with right-click -> Open, or run:
#   xattr -dr com.apple.quarantine "/Applications/Proxytop.app"
cask "proxytop" do
  version "1.2.0"
  sha256 "fa56a7b9671b82a90a0ae3b0393bbcaa9a3b9aaebbb2b07e10bcc51ecb4f8d6f"

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
