import type {
  ClassificationContext,
  Confidence,
  FlowSample,
  Listener,
  NetworkSnapshot,
  PathKind,
  ProxyEngineInfo,
} from "./domain"
import { isIP } from "node:net"
import { isLocalDestination } from "./network-address"

export interface Classification {
  path: PathKind
  confidence: Confidence
  evidence: string[]
}

/** Known client / engine names, including common airport shells. */
const PROXY_PROCESS =
  /shadowrocket|macpacket|clash|mihomo|hiddify|sing-?box|surge|stash|quantumult|loon|pharos|v2rayn?g?|xray|v2box|nekoray|nekobox|throne|karing|flclash|clashx|verge|sakura|sfm|leaf|hysteria2?|tuic|naive|brook|gost|dante|privoxy|proxifier|trojan(?:-go)?|ss-?local|tun2socks|sager|v2raya|qv2ray|kitsunebi|outline|wireguard|openvpn|openconnect|tailscale|cloudflare.?warp|warp-svc|expressvpn|nordvpn|surfshark|mullvad|proton.?vpn|viscosity|tunnelblick|potatso|shadowsocks|juicity|streisand/i

/** Ports commonly used by local HTTP/SOCKS/mixed proxy listeners (avoid generic 8080/3000). */
const COMMON_PROXY_PORTS = new Set([
  1080, 1081, 1082, 1086, 1087, 1088, 2080, 2087,
  6152, 6153, 7070, 7890, 7891, 7892, 7893, 7897,
  8118, 8889, 9050, 9051, 10808, 10809, 20170, 20171, 20172,
  51837, 51838, 61100, 61101, 10080, 10086, 12334, 12335,
])

export function knownProxyProcess(process: string): boolean {
  return PROXY_PROCESS.test(process)
}

export function isCommonProxyPort(port: number | undefined): boolean {
  return typeof port === "number" && COMMON_PROXY_PORTS.has(port)
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "*"
}


function configuredProxyEndpoints(context: ClassificationContext): Array<{ host: string; port: number }> {
  const proxy = context.snapshot.proxy
  const endpoints: Array<{ host: string; port: number }> = []
  if (proxy.httpEnabled && proxy.httpHost && proxy.httpPort) endpoints.push({ host: proxy.httpHost, port: proxy.httpPort })
  if (proxy.httpsEnabled && proxy.httpsHost && proxy.httpsPort) endpoints.push({ host: proxy.httpsHost, port: proxy.httpsPort })
  if (proxy.socksEnabled && proxy.socksHost && proxy.socksPort) endpoints.push({ host: proxy.socksHost, port: proxy.socksPort })
  return endpoints
}

function sameHost(left: string, right: string): boolean {
  if (left.toLowerCase() === right.toLowerCase()) return true
  return isLoopback(left) && isLoopback(right)
}

function systemProxyPorts(snapshot: NetworkSnapshot): Set<number> {
  const ports = new Set<number>()
  const proxy = snapshot.proxy
  if (proxy.httpEnabled && proxy.httpPort) ports.add(proxy.httpPort)
  if (proxy.httpsEnabled && proxy.httpsPort) ports.add(proxy.httpsPort)
  if (proxy.socksEnabled && proxy.socksPort) ports.add(proxy.socksPort)
  return ports
}

function listenerLooksLocal(listener: Listener): boolean {
  return isLoopback(listener.host) || listener.host === "0.0.0.0" || listener.host === "::" || listener.host === "*"
}

/** Discover proxy engines beyond the name whitelist (system proxy owner, common ports, listen+outbound). */
export function discoverProxyEngines(
  snapshot: NetworkSnapshot,
  flows: Iterable<FlowSample> = [],
): { proxyProcesses: Set<string>; engines: ProxyEngineInfo[] } {
  const byProcess = new Map<
    string,
    { pids: Set<number>; ports: Set<string>; roles: Set<string>; vpnInterfaces: Set<string> }
  >()

  const ensure = (process: string) => {
    const existing = byProcess.get(process) ?? {
      pids: new Set<number>(),
      ports: new Set<string>(),
      roles: new Set<string>(),
      vpnInterfaces: new Set<string>(),
    }
    byProcess.set(process, existing)
    return existing
  }

  const sysPorts = systemProxyPorts(snapshot)

  for (const listener of snapshot.listeners) {
    if (!listenerLooksLocal(listener)) continue
    const entry = ensure(listener.process)
    entry.pids.add(listener.pid)
    entry.ports.add(`${listener.host === "*" ? "0.0.0.0" : listener.host}:${listener.port}`)
    if (knownProxyProcess(listener.process)) entry.roles.add("known-client")
    if (sysPorts.has(listener.port)) entry.roles.add("system-proxy")
    if (isCommonProxyPort(listener.port)) entry.roles.add("common-port")
  }

  for (const service of snapshot.vpnServices) {
    if (!/connect/i.test(service.state)) continue
    const name = service.name || "VPN"
    const entry = ensure(name)
    entry.roles.add("vpn-service")
    if (service.interfaceName) entry.vpnInterfaces.add(service.interfaceName)
    if (service.sessionPid) entry.pids.add(service.sessionPid)
    if (knownProxyProcess(name) || (service.providerBundleId && knownProxyProcess(service.providerBundleId))) {
      entry.roles.add("known-client")
    }
  }

  for (const item of snapshot.interfaces) {
    if ((item.kind === "vpn" || item.kind === "tunnel") && item.owner) {
      const entry = ensure(item.owner)
      entry.roles.add(item.kind === "vpn" ? "vpn-tunnel" : "tunnel")
      entry.vpnInterfaces.add(item.name)
    }
  }

  const loopbackListeners = new Set(
    snapshot.listeners.filter((item) => listenerLooksLocal(item)).map((item) => item.process),
  )
  const physical = new Set(snapshot.physicalInterfaces)

  for (const flow of flows) {
    if (knownProxyProcess(flow.process)) {
      const entry = ensure(flow.process)
      entry.pids.add(flow.pid)
      entry.roles.add("known-client")
    }
    if (
      loopbackListeners.has(flow.process) &&
      flow.interfaceName &&
      physical.has(flow.interfaceName) &&
      flow.remote.host !== "*" &&
      !isLocalDestination(flow.remote.host)
    ) {
      const entry = ensure(flow.process)
      entry.pids.add(flow.pid)
      entry.roles.add("listen+outbound")
    }
  }

  // Keep only processes with at least one discovery role.
  for (const [process, entry] of [...byProcess.entries()]) {
    if (entry.roles.size === 0) byProcess.delete(process)
  }

  const proxyProcesses = new Set(
    [...byProcess.entries()]
      .filter(([, entry]) =>
        [...entry.roles].some((role) =>
          ["known-client", "system-proxy", "common-port", "vpn-service", "vpn-tunnel"].includes(role),
        ),
      )
      .map(([process]) => process),
  )
  // A listener plus outbound traffic is only a candidate until another signal identifies it as a proxy.
  for (const flow of flows) {
    if (knownProxyProcess(flow.process)) proxyProcesses.add(flow.process)
  }

  const engines: ProxyEngineInfo[] = [...byProcess.entries()]
    .map(([process, entry]) => ({
      process,
      pids: [...entry.pids],
      ports: [...entry.ports].sort(),
      roles: [...entry.roles].sort(),
      vpnInterfaces: [...entry.vpnInterfaces].sort(),
    }))
    .sort((left, right) => left.process.localeCompare(right.process))

  return { proxyProcesses, engines }
}

function isProxyListener(listener: Listener, context: ClassificationContext): boolean {
  if (!listenerLooksLocal(listener) && !isLoopback(listener.host)) return false
  if (knownProxyProcess(listener.process)) return true
  if (context.proxyProcesses.has(listener.process)) return true
  if (systemProxyPorts(context.snapshot).has(listener.port)) return true
  if (isCommonProxyPort(listener.port)) return true
  return false
}

/** Host-side egress: Wi-Fi/Ethernet, and VM bridges that still mean "not through local proxy/VPN". */
function isDirectEgressInterface(
  interfaceName: string | undefined,
  context: ClassificationContext,
): boolean {
  if (!interfaceName || interfaceName === "lo0") return false
  if (context.snapshot.physicalInterfaces.includes(interfaceName)) return true
  if (interfaceName.startsWith("utun")) return false
  const info = context.snapshot.interfaces.find((item) => item.name === interfaceName)
  if (info?.kind === "vpn" || info?.kind === "tunnel" || info?.kind === "zerotier") return false
  if (/^(bridge|vmenet|vmnet|ap)\d*/i.test(interfaceName)) return true
  if (info?.kind === "virtual" || info?.kind === "physical") return true
  return false
}

export function classifyFlow(
  flow: FlowSample,
  context: ClassificationContext,
): Classification {
  const interfaceName = flow.interfaceName
  const proxyProcess = knownProxyProcess(flow.process) || context.proxyProcesses.has(flow.process)
  const proxyEndpoint = configuredProxyEndpoints(context).find(
    (endpoint) => endpoint.port === flow.remote.port && sameHost(endpoint.host, flow.remote.host),
  )
  const unresolvedProxyEndpoint = configuredProxyEndpoints(context).find(
    (endpoint) =>
      endpoint.port === flow.remote.port &&
      isIP(endpoint.host) === 0 &&
      isIP(flow.remote.host) !== 0,
  )
  const listener = context.snapshot.listeners.find(
    (candidate) =>
      candidate.port === flow.remote.port &&
      isLoopback(flow.remote.host) &&
      isProxyListener(candidate, context),
  )

  if (flow.remote.port && (proxyEndpoint || listener)) {
    return {
      path: "LOCAL_PROXY",
      confidence: proxyEndpoint || (listener && (knownProxyProcess(listener.process) || systemProxyPorts(context.snapshot).has(listener.port)))
        ? "HIGH"
        : "MEDIUM",
      evidence: [
        `${flow.process} connects to proxy endpoint ${flow.remote.host}:${flow.remote.port}`,
        listener
          ? `${listener.process} (${listener.pid}) owns the listener`
          : "host and port match an enabled system proxy",
      ],
    }
  }

  if (unresolvedProxyEndpoint) {
    return {
      path: "UNKNOWN",
      confidence: "MEDIUM",
      evidence: [
        `destination port matches enabled proxy ${unresolvedProxyEndpoint.host}:${unresolvedProxyEndpoint.port}`,
        `nettop reported numeric address ${flow.remote.host}; hostname resolution is intentionally not triggered`,
      ],
    }
  }

  if (proxyProcess && interfaceName && context.snapshot.physicalInterfaces.includes(interfaceName)) {
    // Engine sockets on physical egress (including unbound UDP) are outer path, not app leaks.
    if (flow.remote.host === "*" || !isLocalDestination(flow.remote.host)) {
      return {
        path: "PROXY_OUTBOUND",
        confidence: flow.interfaceSource === "route" ? "MEDIUM" : "HIGH",
        evidence: [
          `${flow.process} is a proxy engine`,
          `outbound connection uses physical interface ${interfaceName}`,
          ...(flow.interfaceSource === "route" ? ["interface came from a best-effort route-table lookup"] : []),
        ],
      }
    }
  }

  const interfaceInfo = context.snapshot.interfaces.find((item) => item.name === interfaceName)
  if (interfaceInfo?.kind === "zerotier") {
    return {
      path: "OVERLAY",
      confidence: interfaceInfo.ownerConfidence || "MEDIUM",
      evidence: [
        `connection uses overlay interface ${interfaceInfo.name}`,
        `${interfaceInfo.owner || "virtual network"} owns the interface`,
      ],
    }
  }

  if (interfaceName?.startsWith("utun")) {
    const isDefault = interfaceName === context.snapshot.defaultInterface
    const isVpn = context.snapshot.vpnInterfaces.includes(interfaceName)
    if (!isDefault && !isVpn && interfaceInfo?.owner) {
      return {
        path: "OVERLAY",
        confidence: interfaceInfo.ownerConfidence || "MEDIUM",
        evidence: [
          `connection uses attributed system tunnel ${interfaceName}`,
          `${interfaceInfo.owner} owns or advertises the tunnel`,
        ],
      }
    }
    return {
      path: isDefault || isVpn ? "TUNNELED" : "UNKNOWN",
      confidence: isDefault && isVpn && flow.interfaceSource !== "route" ? "HIGH" : "MEDIUM",
      evidence: [
        `connection uses ${interfaceName}`,
        isDefault ? "interface is the default route" : "interface is not the default route",
        isVpn ? "macOS identifies the interface as VPN-backed" : "tunnel owner is not confirmed",
        ...(flow.interfaceSource === "route" ? ["interface came from a best-effort route-table lookup"] : []),
      ],
    }
  }

  if (flow.remote.host === "*") {
    return {
      path: "UNKNOWN",
      confidence: "LOW",
      evidence: ["socket has no connected remote peer; its route cannot be determined"],
    }
  }

  if (isLocalDestination(flow.remote.host)) {
    return {
      path: "LAN",
      confidence: "HIGH",
      evidence: [`destination ${flow.remote.host} is local, private, or link-local on ${interfaceName || "an unknown interface"}`],
    }
  }

  if (isDirectEgressInterface(interfaceName, context)) {
    return {
      path: "DIRECT",
      confidence: context.snapshot.physicalInterfaces.includes(interfaceName || "") && flow.interfaceSource !== "route" ? "HIGH" : "MEDIUM",
      evidence: [
        `connection uses ${interfaceName}`,
        interfaceName && context.snapshot.physicalInterfaces.includes(interfaceName)
          ? "physical interface; no local proxy hop was observed"
          : "host/VM bridge egress; no local proxy hop was observed",
        ...(flow.interfaceSource === "route" ? ["interface came from a best-effort route-table lookup"] : []),
      ],
    }
  }

  return {
    path: "UNKNOWN",
    confidence: "LOW",
    evidence: [interfaceName ? `unrecognized interface ${interfaceName}` : "nettop reported no interface"],
  }
}
