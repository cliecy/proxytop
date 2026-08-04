import SwiftUI

enum AppSection: String, CaseIterable, Identifiable {
  case apps = "Apps"
  case status = "Status"
  case settings = "Settings"

  var id: String { rawValue }
}

struct ContentView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      Picker(
        "Section",
        selection: Binding(
          get: { model.section },
          set: { model.section = $0 }
        )
      ) {
        ForEach(AppSection.allCases) { section in
          Text(section.rawValue).tag(section)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal, 12)
      .padding(.top, 12)
      .padding(.bottom, 8)

      switch model.section {
      case .apps:
        AppsView(model: model)
      case .status:
        StatusView(model: model)
      case .settings:
        SettingsView(model: model)
      }
    }
    .frame(width: 380)
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

struct AppsView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      Divider()
      appList
      if let app = model.selectedApp {
        Divider()
        AppDetailView(app: app, language: model.language)
      }
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 12)
  }

  private var header: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text("↓ \(formatRate(model.snapshot?.wanRate.inRate ?? 0))")
          .font(.system(size: 11, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(.green)
        Text("↑ \(formatRate(model.snapshot?.wanRate.outRate ?? 0))")
          .font(.system(size: 11, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(.orange)
      }
      Spacer()
      SparklineView(values: model.snapshot?.history.inbound ?? [], color: .green)
        .frame(width: 120, height: 28)
      SparklineView(values: model.snapshot?.history.outbound ?? [], color: .orange)
        .frame(width: 120, height: 28)
    }
  }

  private var appList: some View {
    ScrollView {
      LazyVStack(spacing: 1) {
        if model.sortedApps.isEmpty {
          VStack(spacing: 6) {
            Text(model.connected ? "等待采集数据…" : "引擎未连接")
              .foregroundStyle(.secondary)
            if let error = model.lastError {
              Text(error)
                .font(.caption)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
            }
          }
          .padding(.top, 40)
        } else {
          ForEach(model.sortedApps) { app in
            AppRow(
              app: app,
              selected: app.process == model.selectedProcess,
              onSelect: { model.selectedProcess = app.process }
            )
          }
        }
      }
    }
  }
}

struct AppRow: View {
  let app: SerializedApp
  let selected: Bool
  let onSelect: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 6) {
        Text(app.process)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 4)
        Text(flags)
          .font(.caption)
        Text("↓\(formatRate(app.rateIn)) ↑\(formatRate(app.rateOut))")
          .font(.system(size: 10).monospacedDigit())
          .foregroundStyle(.secondary)
        Text(app.verdict)
          .font(.system(size: 9, weight: .bold))
          .padding(.horizontal, 5)
          .padding(.vertical, 2)
          .background(Capsule().fill(color.opacity(0.18)))
          .foregroundStyle(color)
        Text("\(app.connections)")
          .font(.system(size: 10).monospacedDigit())
          .foregroundStyle(.tertiary)
      }
      HStack(spacing: 4) {
        Text("via \(appVia(app))")
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
        if appProtocol(app) != "-" {
          Text("· \(appProtocol(app))")
            .font(.system(size: 10))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }
    }
    .padding(.vertical, 3)
    .padding(.horizontal, 6)
    .background(selected ? Color.accentColor.opacity(0.15) : Color.clear)
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .contentShape(Rectangle())
    .onTapGesture(perform: onSelect)
  }

  private var color: Color { verdictColor(app.verdict) }

  private var flags: String {
    app.regions.prefix(3).map { flagEmoji(for: $0) }.joined()
  }
}

struct AppDetailView: View {
  let app: SerializedApp
  let language: String

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      DetailLine(
        label: localText(language, "APPLICATION", "应用程序"),
        chunks: [
          (app.process, Color.primary),
          ("  PID=\(app.pids.map(String.init).joined(separator: ","))", .secondary),
          ("  \(verdictLabel(app.verdict, language: language))", verdictColor(app.verdict)),
          ("  \(localText(language, "confidence", "置信度"))=\(app.confidence)", .secondary),
        ]
      )
      DetailLine(
        label: localText(language, "OBSERVED PATH", "观测路径"),
        chunks: [
          (pathSummary, verdictColor(app.verdict)),
        ]
      )
      DetailLine(
        label: localText(language, "PROXY / TRANSPORT", "代理 / 传输"),
        chunks: [
          (app.proxyProtocols.joined(separator: ", ").isEmpty ? localText(language, "none observed", "未观测到") : app.proxyProtocols.joined(separator: ", "), .primary),
          (" | \(app.transports.joined(separator: ", "))", .secondary),
        ]
      )
      DetailLine(
        label: localText(language, "CONTROLLER / RULE", "控制器 / 规则"),
        chunks: [
          (app.proxyChains.isEmpty ? localText(language, "not available", "不可用") : app.proxyChains.joined(separator: " | "), app.proxyChains.isEmpty ? .secondary : .green),
          (app.rules.isEmpty ? "" : "  \(app.rules.joined(separator: " | "))", .orange),
        ]
      )
      DetailLine(
        label: localText(language, "INTERFACES", "网络接口"),
        chunks: [
          (app.interfaces.joined(separator: ", "), .primary),
          (" | \(localText(language, "tunnel", "隧道"))=\(app.tunnelOwners.joined(separator: ", "))", .secondary),
        ]
      )
      DetailLine(
        label: localText(language, "DESTINATIONS", "目标"),
        chunks: [
          (destinationSummary, hiddenDestination ? .orange : .primary),
        ]
      )
      DetailLine(
        label: localText(language, "TARGET COUNTRY", "目标国家"),
        chunks: [
          (targetCountry, targetCountryColor),
        ]
      )
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var pathSummary: String {
    let paths = app.paths.map { pathLabel($0, language: language) }.joined(separator: " + ")
    return "\(paths) | \(localText(language, "via", "路径"))=\(appVia(app))"
  }

  private var hiddenDestination: Bool {
    !app.proxyHops.isEmpty && app.destinations.isEmpty
  }

  private var destinationSummary: String {
    if hiddenDestination {
      return localText(language, "hidden behind local proxy", "被本地代理隐藏")
    }
    return app.destinations.isEmpty ? localText(language, "none", "无") : app.destinations.joined(separator: ", ")
  }

  private var targetCountry: String {
    if !app.regions.isEmpty { return app.regions.joined(separator: ", ") }
    if hiddenDestination || app.paths.contains("TUNNELED") {
      return localText(language, "hidden by proxy/VPN; provider API required", "已被代理/VPN 隐藏；需要服务商 API")
    }
    return localText(language, "unknown", "未知")
  }

  private var targetCountryColor: Color {
    if !app.regions.isEmpty { return .primary }
    if hiddenDestination || app.paths.contains("TUNNELED") { return .orange }
    return .secondary
  }
}

struct DetailLine: View {
  let label: String
  let chunks: [(String, Color)]

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(label.uppercased())
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(.secondary)
        .frame(width: 108, alignment: .leading)
      Text(joined)
        .font(.system(size: 10))
        .lineLimit(2)
        .truncationMode(.tail)
      Spacer(minLength: 0)
    }
  }

  private var joined: AttributedString {
    var result = AttributedString()
    for (index, chunk) in chunks.enumerated() where !chunk.0.isEmpty {
      var part = AttributedString(chunk.0)
      part.foregroundColor = chunk.1
      if index > 0 { result += AttributedString(" ") }
      result += part
    }
    return result
  }
}

struct SparklineView: View {
  let values: [Double]
  let color: Color

  var body: some View {
    GeometryReader { geo in
      let path = makePath(in: geo.size)
      path.stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
    }
  }

  private func makePath(in size: CGSize) -> Path {
    guard size.width > 0, size.height > 0 else { return Path() }
    let window = values.suffix(60)
    guard let maxValue = window.max(), maxValue > 0 else { return Path() }
    var path = Path()
    for (index, value) in window.enumerated() {
      let x = CGFloat(index) / CGFloat(max(window.count - 1, 1)) * size.width
      let y = size.height - CGFloat(value / maxValue) * size.height
      if index == 0 {
        path.move(to: CGPoint(x: x, y: y))
      } else {
        path.addLine(to: CGPoint(x: x, y: y))
      }
    }
    return path
  }
}
