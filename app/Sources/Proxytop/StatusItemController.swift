import AppKit
import SwiftUI

@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
  static let shared = StatusItemController()

  private var statusItem: NSStatusItem?
  private var popover: NSPopover?

  private override init() {
    super.init()
  }

  func setup() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      button.image = NSImage(
        systemSymbolName: "point.3.connected.trianglepath.dotted",
        accessibilityDescription: "Proxytop"
      )
      button.imagePosition = .imageOnly
      button.target = self
      button.action = #selector(togglePopover(_:))
    }
    statusItem = item

    let popover = NSPopover()
    popover.behavior = .transient
    popover.animates = true
    popover.delegate = self
    popover.contentViewController = NSHostingController(rootView: ContentView(model: AppModel.shared))
    popover.contentSize = NSSize(width: 380, height: 600)
    self.popover = popover
  }

  @objc private func togglePopover(_ sender: Any?) {
    guard let popover, let button = statusItem?.button else { return }
    if popover.isShown {
      popover.performClose(sender)
    } else {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
    }
  }
}
