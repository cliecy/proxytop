import SwiftUI

struct StatusView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(rows, id: \.label) { row in
          HStack(alignment: .top, spacing: 6) {
            Text(row.label)
              .font(.system(size: 10, weight: .bold))
              .foregroundStyle(.secondary)
              .frame(width: 92, alignment: .leading)
            Text(row.value)
              .font(.system(size: 10))
              .foregroundStyle(row.color)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.vertical, 2)
        }
      }
      .padding(12)
    }
  }

  private var rows: [(label: String, value: String, color: Color)] {
    let statuses = model.snapshot?.statuses
    let header = model.snapshot?.header
    var rows: [(String, String, Color)] = [
      ("nettop", statuses?.nettop ?? "-", stateColor(statuses?.nettop)),
      ("clash", statuses?.clash ?? "-", stateColor(statuses?.clash)),
      ("pktap", statuses?.pktap ?? "-", stateColor(statuses?.pktap)),
      ("geo", statuses?.geo ?? "-", stateColor(statuses?.geo)),
    ]

    if let proxy = header?.proxy {
      if proxy.endpoints.isEmpty {
        rows.append(("SYSTEM PROXY", "disabled", .secondary))
      } else {
        rows.append(("SYSTEM PROXY", proxy.endpoints.joined(separator: "  "), .green))
      }
    }

    rows.append(("DEFAULT PATH", header?.defaultInterface ?? "-", .secondary))
    if let header, !header.vpnServices.isEmpty {
      for service in header.vpnServices {
        let name = service.interfaceName.map { "\(service.name) · \($0)" } ?? service.name
        rows.append(("VPN SERVICE", "\(name) · \(service.state)", stateColor(service.state)))
      }
    }

    if let header {
      for item in header.interfaces {
        let roles = [
          item.isDefault ? "DEFAULT" : nil,
          item.carriesDns ? "DNS" : nil,
        ].compactMap { $0 }.joined(separator: " ")
        let roleSuffix = roles.isEmpty ? "" : " [\(roles)]"
        rows.append((
          item.kind.uppercased(),
          "\(item.name) · \(item.owner ?? "unattributed")\(item.status == "active" ? "" : " · \(item.status)")\(roleSuffix)",
          item.isDefault ? .orange : .primary
        ))
      }
    }

    let coverage = model.coverageSummary
    rows.append((
      localText(model.language, "COVERAGE", "覆盖"),
      localText(
        model.language,
        "\(coverage.proxied) proxied · \(coverage.direct) direct · \(coverage.mixed) mixed",
        "\(coverage.proxied) 代理 · \(coverage.direct) 直连 · \(coverage.mixed) 混合"
      ),
      coverage.direct > 0 || coverage.mixed > 0 ? .orange : .green
    ))
    rows.append((localText(model.language, "APPS", "应用数"), "\(model.snapshot?.apps.count ?? 0)", .secondary))
    if let error = model.lastError {
      rows.append((localText(model.language, "ENGINE ERROR", "引擎错误"), error, .red))
    }
    return rows
  }

  private func stateColor(_ value: String?) -> Color {
    guard let value else { return .secondary }
    let lower = value.lowercased()
    if lower.contains("inactive") || lower.contains("disconnected") || lower.contains("disabled")
      || lower.contains("offline") || lower.contains("error") || lower.contains("失败") || lower.contains("未安装") {
      return .red
    }
    if lower.contains("active") || lower.contains("connected") || lower.contains("enabled")
      || lower.contains("listening") || lower.contains("ready") || lower.contains("ok") {
      return .green
    }
    return .secondary
  }
}
