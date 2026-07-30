import type {
  ClassificationContext,
  Confidence,
  FlowSample,
  PathKind,
} from "./domain"
import { isIP } from "node:net"

export interface Classification {
  path: PathKind
  confidence: Confidence
  evidence: string[]
}

const PROXY_PROCESS = /shadowrocket|macpacket|clash|mihomo|hiddify|sing-box|surge|stash/i

export function knownProxyProcess(process: string): boolean {
  return PROXY_PROCESS.test(process)
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function isLan(host: string): boolean {
  if (isLoopback(host) || host.endsWith(".local")) return true
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true
  const private172 = host.match(/^172\.(\d+)\./)
  if (private172?.[1] && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true
  if (/^169\.254\./.test(host) || /^fe80:/i.test(host) || /^ff0[0-9a-f]:/i.test(host)) return true
  return false
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
      knownProxyProcess(candidate.process),
  )

  if (flow.remote.port && (proxyEndpoint || listener)) {
    return {
      path: "LOCAL_PROXY",
      confidence: "HIGH",
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
    return {
      path: "PROXY_OUTBOUND",
      confidence: "HIGH",
      evidence: [
        `${flow.process} is a proxy engine`,
        `outbound connection uses physical interface ${interfaceName}`,
      ],
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
      confidence: isDefault && isVpn ? "HIGH" : "MEDIUM",
      evidence: [
        `connection uses ${interfaceName}`,
        isDefault ? "interface is the default route" : "interface is not the default route",
        isVpn ? "macOS identifies the interface as VPN-backed" : "tunnel owner is not confirmed",
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

  if (isLan(flow.remote.host)) {
    return {
      path: "LAN",
      confidence: "HIGH",
      evidence: [`destination ${flow.remote.host} is local, private, or link-local on ${interfaceName || "an unknown interface"}`],
    }
  }

  if (interfaceName && context.snapshot.physicalInterfaces.includes(interfaceName)) {
    return {
      path: "DIRECT",
      confidence: "HIGH",
      evidence: [`connection uses physical interface ${interfaceName}`, "no local proxy hop was observed"],
    }
  }

  return {
    path: "UNKNOWN",
    confidence: "LOW",
    evidence: [interfaceName ? `unrecognized interface ${interfaceName}` : "nettop reported no interface"],
  }
}
