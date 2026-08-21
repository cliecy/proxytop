export type Protocol = "tcp" | "udp"

export type PathKind =
  | "LOCAL_PROXY"
  | "TUNNELED"
  | "DIRECT"
  | "PROXY_OUTBOUND"
  | "OVERLAY"
  | "LAN"
  | "BYPASSED"
  | "UNKNOWN"

export type Confidence = "HIGH" | "MEDIUM" | "LOW"

export interface Endpoint {
  raw: string
  host: string
  port?: number
}

export interface FlowSample {
  timestamp: number
  pid: number
  process: string
  protocol: Protocol
  family: 4 | 6
  local: Endpoint
  remote: Endpoint
  interfaceName?: string
  /** Whether the interface came from nettop or a best-effort route-table fallback. */
  interfaceSource?: "nettop" | "route"
  state?: string
  bytesIn: number
  bytesOut: number
  rttMs?: number
}

export interface ClassifiedFlow extends FlowSample {
  id: string
  path: PathKind
  confidence: Confidence
  evidence: string[]
  rateIn: number
  rateOut: number
  firstSeen: number
  lastSeen: number
}

export interface ProxyConfig {
  httpEnabled: boolean
  httpHost?: string
  httpPort?: number
  httpsEnabled: boolean
  httpsHost?: string
  httpsPort?: number
  socksEnabled: boolean
  socksHost?: string
  socksPort?: number
  pacEnabled: boolean
  exceptions: string[]
}

export interface Listener {
  process: string
  pid: number
  user?: string
  host: string
  port: number
}

export interface VpnService {
  id: string
  name: string
  bundleId?: string
  providerBundleId?: string
  state: string
  interfaceName?: string
  sessionPid?: number
  serverAddress?: string
  primary: boolean
}

export type InterfaceKind = "physical" | "vpn" | "tunnel" | "zerotier" | "virtual" | "loopback"

export interface NetworkInterfaceInfo {
  name: string
  kind: InterfaceKind
  status: "active" | "inactive" | "unknown"
  addresses: string[]
  mtu?: number
  owner?: string
  ownerConfidence?: Confidence
  effectiveInterface?: string
  isDefault: boolean
  carriesDns: boolean
}

export interface DnsResolver {
  interfaceName?: string
  servers: string[]
  scoped: boolean
  supplemental: boolean
}

export interface OverlayNetwork {
  provider: "ZeroTier"
  id: string
  name: string
  interfaceName: string
  status: string
  addresses: string[]
  routes: string[]
}

export interface NetworkSnapshot {
  collectedAt: number
  proxy: ProxyConfig
  defaultInterface?: string
  physicalInterfaces: string[]
  tunnelInterfaces: string[]
  vpnInterfaces: string[]
  listeners: Listener[]
  vpnServices: VpnService[]
  interfaces: NetworkInterfaceInfo[]
  dnsResolvers: DnsResolver[]
  overlayNetworks: OverlayNetwork[]
  errors: string[]
}

export interface ClassificationContext {
  snapshot: NetworkSnapshot
  proxyProcesses: Set<string>
}

export interface ProcessAggregate {
  pid: number
  process: string
  path: PathKind
  connections: number
  rateIn: number
  rateOut: number
  bytesIn: number
  bytesOut: number
}

export type AppVerdict = "PROXIED" | "DIRECT" | "BYPASSED" | "MIXED" | "OVERLAY" | "ENGINE" | "LOCAL" | "UNKNOWN"

/** How this app's traffic is controlled (human-readable). */
export type ControlMechanism =
  | "system-proxy"
  | "local-proxy"
  | "vpn-tun"
  | "overlay"
  | "controller"
  | "engine-outbound"
  | "direct"
  | "mixed"
  | "local"
  | "unknown"

export interface ProxyEngineInfo {
  process: string
  pids: number[]
  ports: string[]
  roles: string[]
  vpnInterfaces: string[]
}

export interface AppSummary {
  process: string
  pids: number[]
  verdict: AppVerdict
  paths: PathKind[]
  /** Human-readable control path: system proxy / local hop / VPN / direct. */
  mechanism: string
  control: ControlMechanism
  connections: number
  rateIn: number
  rateOut: number
  proxyHops: string[]
  proxyProtocols: string[]
  interfaces: string[]
  tunnelOwners: string[]
  transports: string[]
  destinations: string[]
  /** Target/remote IP allocation country (not guaranteed exit). */
  regions: string[]
  /** VPN server or proxy-engine outer hop country. */
  nodeRegions: string[]
  rules: string[]
  proxyChains: string[]
  confidence: Confidence
}

export interface PacketEvidence {
  timestamp: number
  pid?: number
  process?: string
  interfaceName?: string
  direction?: "in" | "out"
  bytes?: number
  raw: string
}

export interface ProxyControllerConnection {
  id: string
  process?: string
  sourceIp?: string
  sourcePort?: number
  destinationIp?: string
  destinationPort?: number
  host?: string
  network?: string
  rule?: string
  rulePayload?: string
  chains: string[]
  upload: number
  download: number
}

export interface ProxyControllerSnapshot {
  kind: "clash"
  url: string
  collectedAt: number
  connections: ProxyControllerConnection[]
}
