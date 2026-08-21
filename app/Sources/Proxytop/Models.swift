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
  let mechanism: String
  let control: String
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
  let nodeRegions: [String]
  let proxyChains: [String]
  let rules: [String]
  let confidence: String

  var totalRate: Double { rateIn + rateOut }

  enum CodingKeys: String, CodingKey {
    case process, pids, verdict, paths, mechanism, control, connections, rateIn, rateOut
    case proxyHops, proxyProtocols, interfaces, tunnelOwners, transports
    case destinations, regions, nodeRegions, proxyChains, rules, confidence
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    process = try container.decode(String.self, forKey: .process)
    pids = try container.decode([Int].self, forKey: .pids)
    verdict = try container.decode(String.self, forKey: .verdict)
    paths = try container.decode([String].self, forKey: .paths)
    mechanism = try container.decodeIfPresent(String.self, forKey: .mechanism) ?? ""
    control = try container.decodeIfPresent(String.self, forKey: .control) ?? ""
    connections = try container.decode(Int.self, forKey: .connections)
    rateIn = try container.decode(Double.self, forKey: .rateIn)
    rateOut = try container.decode(Double.self, forKey: .rateOut)
    proxyHops = try container.decode([String].self, forKey: .proxyHops)
    proxyProtocols = try container.decode([String].self, forKey: .proxyProtocols)
    interfaces = try container.decode([String].self, forKey: .interfaces)
    tunnelOwners = try container.decode([String].self, forKey: .tunnelOwners)
    transports = try container.decode([String].self, forKey: .transports)
    destinations = try container.decode([String].self, forKey: .destinations)
    regions = try container.decode([String].self, forKey: .regions)
    nodeRegions = try container.decodeIfPresent([String].self, forKey: .nodeRegions) ?? []
    proxyChains = try container.decode([String].self, forKey: .proxyChains)
    rules = try container.decode([String].self, forKey: .rules)
    confidence = try container.decode(String.self, forKey: .confidence)
  }
}

struct SerializedEngine: Decodable, Identifiable {
  var id: String { process }
  let process: String
  let pids: [Int]
  let ports: [String]
  let roles: [String]
  let vpnInterfaces: [String]
}

struct DaemonSnapshot: Decodable {
  let kind: String
  let collectedAt: Double
  let wanRate: Rate
  let totals: Rate
  let history: History
  let apps: [SerializedApp]
  let engines: [SerializedEngine]
  let statuses: Statuses
  let header: Header?
  let errors: [String]

  enum CodingKeys: String, CodingKey {
    case kind, collectedAt, wanRate, totals, history, apps, engines, statuses, header, errors
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    kind = try container.decode(String.self, forKey: .kind)
    collectedAt = try container.decode(Double.self, forKey: .collectedAt)
    wanRate = try container.decode(Rate.self, forKey: .wanRate)
    totals = try container.decode(Rate.self, forKey: .totals)
    history = try container.decode(History.self, forKey: .history)
    apps = try container.decode([SerializedApp].self, forKey: .apps)
    engines = try container.decodeIfPresent([SerializedEngine].self, forKey: .engines) ?? []
    statuses = try container.decode(Statuses.self, forKey: .statuses)
    header = try container.decodeIfPresent(Header.self, forKey: .header)
    errors = try container.decodeIfPresent([String].self, forKey: .errors) ?? []
  }
}
