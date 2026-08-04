import SwiftUI

@main
struct ProxytopApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    Settings {
      EmptyView()
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    StatusItemController.shared.setup()
    AppModel.shared.start()
  }

  func applicationWillTerminate(_ notification: Notification) {
    AppModel.shared.stop()
  }
}
