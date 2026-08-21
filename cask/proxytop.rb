# typed: strict
# frozen_string_literal: true

# Reference copy of the Homebrew cask. The published cask is `proxytop-app`
# in the cliecy/tap tap: https://github.com/cliecy/homebrew-tap
#   brew tap cliecy/tap
#   brew install --cask cliecy/tap/proxytop-app
#
# It is named `proxytop-app` to avoid colliding with the `proxytop` formula in
# the same tap (a formula and cask with the same name break brew's audit).
#
# This is a reference copy; the cask published in cliecy/tap is authoritative.
cask "proxytop-app" do
  version "1.4.2"
  sha256 "d8a7121738b21a3be16930ec62e9ab02693dcae49a7ba51de01fc5521d52c4ca"

  url "https://github.com/cliecy/proxytop/releases/download/v#{version}/Proxytop-#{version}.dmg",
      verified: "github.com/cliecy/proxytop/"
  name "Proxytop"
  desc "Proxy, VPN, and per-application network path inspector"
  homepage "https://github.com/cliecy/proxytop"

  depends_on macos: :sonoma

  app "Proxytop.app"

  uninstall quit: "com.proxytop.app"

  zap trash: [
    "~/.config/proxytop",
    "~/Library/Application Support/Proxytop",
  ]
end
