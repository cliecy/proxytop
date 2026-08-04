import SwiftUI

func formatBytes(_ value: Double) -> String {
  guard value.isFinite, value > 0 else { return "0 B" }
  let units = ["B", "KiB", "MiB", "GiB", "TiB"]
  var amount = value
  var index = 0
  while amount >= 1024, index < units.count - 1 {
    amount /= 1024
    index += 1
  }
  if index == 0 || amount >= 100 {
    return "\(Int(amount)) \(units[index])"
  }
  return String(format: "%.1f %@", amount, units[index])
}

func formatRate(_ value: Double) -> String {
  "\(formatBytes(value))/s"
}

func flagEmoji(for iso: String) -> String {
  guard iso.count == 2 else { return "🏳️" }
  let base = 127397
  var scalars = String.UnicodeScalarView()
  for scalar in iso.uppercased().unicodeScalars {
    guard let combined = Unicode.Scalar(base + Int(scalar.value)) else { continue }
    scalars.append(combined)
  }
  return String(scalars)
}

func verdictColor(_ verdict: String) -> Color {
  switch verdict {
  case "PROXIED": return .green
  case "DIRECT": return .red
  case "MIXED": return .orange
  case "ENGINE": return .cyan
  case "OVERLAY": return .purple
  case "LOCAL": return .teal
  default: return .gray
  }
}

func localText(_ language: String, _ english: String, _ chinese: String) -> String {
  language == "zh" ? chinese : english
}

func verdictLabel(_ verdict: String, language: String) -> String {
  let labels: [String: (en: String, zh: String)] = [
    "PROXIED": ("PROXIED", "代理"),
    "DIRECT": ("DIRECT", "直连"),
    "MIXED": ("MIXED!", "混合"),
    "OVERLAY": ("OVERLAY", "覆盖"),
    "ENGINE": ("ENGINE", "引擎"),
    "LOCAL": ("LOCAL", "本地"),
    "UNKNOWN": ("UNKNOWN", "未知"),
  ]
  guard let pair = labels[verdict] else { return verdict }
  return language == "zh" ? pair.zh : pair.en
}

func pathLabel(_ path: String, language: String) -> String {
  let labels: [String: (en: String, zh: String)] = [
    "LOCAL_PROXY": ("PROXY", "代理"),
    "TUNNELED": ("TUN", "隧道"),
    "DIRECT": ("DIRECT", "直连"),
    "PROXY_OUTBOUND": ("OUTBOUND", "出站"),
    "OVERLAY": ("OVERLAY", "覆盖"),
    "LAN": ("LAN", "局域网"),
    "BYPASSED": ("BYPASS", "绕过"),
    "UNKNOWN": ("UNKNOWN", "未知"),
  ]
  guard let pair = labels[path] else { return path }
  return language == "zh" ? pair.zh : pair.en
}

func appVia(_ app: SerializedApp) -> String {
  if !app.proxyHops.isEmpty { return app.proxyHops.joined(separator: ", ") }
  if !app.tunnelOwners.isEmpty { return app.tunnelOwners.joined(separator: ", ") }
  return app.interfaces.joined(separator: ", ")
}

func appProtocol(_ app: SerializedApp) -> String {
  var seen = Set<String>()
  var result: [String] = []
  for protocolName in app.proxyProtocols + app.transports where !seen.contains(protocolName) {
    seen.insert(protocolName)
    result.append(protocolName)
  }
  return result.isEmpty ? "-" : result.joined(separator: ", ")
}
