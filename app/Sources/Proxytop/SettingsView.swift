import AppKit
import SwiftUI

struct SettingsView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Toggle(
        localText(model.language, "Launch at login", "开机启动"),
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

      Toggle(
        localText(model.language, "Advanced mode", "高级模式"),
        isOn: Binding(
          get: { model.advancedMode },
          set: { model.setAdvancedMode($0) }
        )
      )
      .font(.system(size: 12))

      Text(localText(
        model.language,
        "Shows Status tab, full evidence, protocols, PIDs, and collector details.",
        "显示状态页、完整证据、协议、PID 与采集器细节。"
      ))
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)

      Divider()

      HStack {
        Text(localText(model.language, "Language", "界面语言"))
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

      Text("\(localText(model.language, "Engine", "引擎")): \(model.enginePath)")
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.middle)

      Spacer()

      Button(localText(model.language, "Quit Proxytop", "退出 Proxytop")) {
        NSApplication.shared.terminate(nil)
      }
      .frame(maxWidth: .infinity)
    }
    .padding(12)
  }
}
