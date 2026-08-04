import Foundation

struct Rate: Decodable {
  let inRate: Double
  let outRate: Double

  enum CodingKeys: String, CodingKey {
    case inRate = "in"
    case outRate = "out"
  }
}

struct History: Decodable {
  let inbound: [Double]
  let outbound: [Double]
}

struct Statuses: Decodable {
  let nettop: String
  let clash: String
  let pktap: String
  let snapshot: String
  let geo: String
}

struct Header: Decodable {
  struct VpnService: Decodable {
    let name: String
    let state: String
    let interfaceName: String?
  }

  struct InterfaceInfo: Decodable {
    let name: String
    let kind: String
    let status: String
    let owner: String?
    let isDefault: Bool
    let carriesDns: Bool
  }

  struct Proxy: Decodable {
    let httpEnabled: Bool
    let httpHost: String?
    let httpPort: Int?
    let httpsEnabled: Bool
    let httpsHost: String?
    let httpsPort: Int?
    let socksEnabled: Bool
    let socksHost: String?
    let socksPort: Int?
    let pacEnabled: Bool
    let exceptions: [String]

    var endpoints: [String] {
      var result: [String] = []
      if httpEnabled, let host = httpHost, let port = httpPort { result.append("HTTP \(host):\(port)") }
      if httpsEnabled, let host = httpsHost, let port = httpsPort { result.append("HTTPS \(host):\(port)") }
      if socksEnabled, let host = socksHost, let port = socksPort { result.append("SOCKS \(host):\(port)") }
      if pacEnabled { result.append("PAC/WPAD") }
      return result
    }
  }

  let defaultInterface: String?
  let physicalInterfaces: [String]
  let vpnServices: [VpnService]
  let interfaces: [InterfaceInfo]
  let proxy: Proxy?
}

struct SerializedApp: Decodable, Identifiable {
  var id: String { process }

  let process: String
  let pids: [Int]
  let verdict: String
  let paths: [String]
  let connections: Int
  let rateIn: Double
  let rateOut: Double
  let proxyHops: [String]
  let proxyProtocols: [String]
  let interfaces: [String]
  let tunnelOwners: [String]
  let transports: [String]
  let destinations: [String]
  let regions: [String]
  let proxyChains: [String]
  let rules: [String]
  let confidence: String

  var totalRate: Double { rateIn + rateOut }
}

struct DaemonSnapshot: Decodable {
  let kind: String
  let collectedAt: Double
  let wanRate: Rate
  let totals: Rate
  let history: History
  let apps: [SerializedApp]
  let statuses: Statuses
  let header: Header?
}
