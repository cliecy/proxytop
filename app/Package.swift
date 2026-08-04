// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Proxytop",
  platforms: [
    .macOS(.v14),
  ],
  targets: [
    .executableTarget(
      name: "Proxytop",
      path: "Sources/Proxytop"
    ),
  ]
)
