import SwiftUI

@main
struct ProxytopApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra("Proxytop", systemImage: "point.3.connected.trianglepath.dotted") {
      ContentView(model: AppModel.shared)
        .frame(width: 380, height: 600)
    }
    .menuBarExtraStyle(.window)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    AppModel.shared.start()
  }

  func applicationWillTerminate(_ notification: Notification) {
    AppModel.shared.stop()
  }
}
