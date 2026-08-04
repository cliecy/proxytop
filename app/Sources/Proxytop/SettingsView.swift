import AppKit
import SwiftUI

struct SettingsView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Toggle(
        "开机启动",
        isOn: Binding(
          get: { model.launchAtLogin },
          set: { enabled in
            model.launchAtLogin = enabled
            model.setLaunchAtLogin(enabled)
          }
        )
      )
      .font(.system(size: 12))

      if let message = model.launchMessage {
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Divider()

      HStack {
        Text("界面语言")
          .font(.system(size: 12))
        Spacer()
        Picker(
          "Language",
          selection: Binding(
            get: { model.language },
            set: { language in
              model.language = language
              model.saveLanguage()
            }
          )
        ) {
          Text("English").tag("en")
          Text("中文").tag("zh")
        }
        .pickerStyle(.segmented)
        .frame(width: 150)
        .labelsHidden()
      }

      Divider()

      Text("引擎位于: \(model.enginePath)")
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.middle)

      Spacer()

      Button("退出 Proxytop") {
        NSApplication.shared.terminate(nil)
      }
      .frame(maxWidth: .infinity)
    }
    .padding(12)
  }
}
