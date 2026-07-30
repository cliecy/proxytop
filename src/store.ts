import { classifyFlow, knownProxyProcess } from "./classifier"
import type {
  AppSummary,
  ClassifiedFlow,
  Confidence,
  FlowSample,
  NetworkSnapshot,
  PathKind,
  ProcessAggregate,
  ProxyControllerConnection,
  ProxyControllerSnapshot,
} from "./domain"
import { isIP } from "node:net"

const PATH_PRIORITY: PathKind[] = [
  "BYPASSED",
  "DIRECT",
  "LOCAL_PROXY",
  "TUNNELED",
  "PROXY_OUTBOUND",
  "OVERLAY",
  "UNKNOWN",
  "LAN",
]

function flowId(flow: FlowSample): string {
  return [
    flow.pid,
    flow.protocol,
    flow.family,
    flow.local.raw,
    flow.remote.raw,
  ].join("|")
}

export class FlowStore {
  private flows = new Map<string, ClassifiedFlow>()
  private snapshot?: NetworkSnapshot
  private historyIn: number[] = []
  private historyOut: number[] = []
  private regionLookup: (host: string) => string | undefined = () => undefined
  private controllerSnapshot?: ProxyControllerSnapshot

  setRegionLookup(lookup: (host: string) => string | undefined): void {
    this.regionLookup = lookup
  }

  setSnapshot(snapshot: NetworkSnapshot): void {
    this.snapshot = snapshot
  }

  getSnapshot(): NetworkSnapshot | undefined {
    return this.snapshot
  }

  setControllerSnapshot(snapshot: ProxyControllerSnapshot | undefined): void {
    this.controllerSnapshot = snapshot
  }

  getControllerSnapshot(): ProxyControllerSnapshot | undefined {
    if (this.controllerSnapshot && Date.now() - this.controllerSnapshot.collectedAt <= 6_000) {
      return this.controllerSnapshot
    }
    this.controllerSnapshot = undefined
    return undefined
  }

  upsert(sample: FlowSample): void {
    if (!this.snapshot) return
    const id = flowId(sample)
    const previous = this.flows.get(id)
    const elapsed = previous ? Math.max((sample.timestamp - previous.lastSeen) / 1_000, 0.001) : 0
    const reliableInterval = elapsed >= 0.25
    const rateIn = previous && reliableInterval && sample.bytesIn >= previous.bytesIn ? (sample.bytesIn - previous.bytesIn) / elapsed : 0
    const rateOut = previous && reliableInterval && sample.bytesOut >= previous.bytesOut ? (sample.bytesOut - previous.bytesOut) / elapsed : 0
    const proxyProcesses = new Set(
      this.snapshot.listeners
        .filter((listener) => knownProxyProcess(listener.process))
        .map((listener) => listener.process),
    )
    const classification = classifyFlow(sample, { snapshot: this.snapshot, proxyProcesses })

    if (!previous && this.flows.size >= 20_000) {
      const oldest = this.flows.keys().next().value
      if (oldest) this.flows.delete(oldest)
    }

    this.flows.set(id, {
      ...sample,
      id,
      ...classification,
      rateIn,
      rateOut,
      firstSeen: previous?.firstSeen ?? sample.timestamp,
      lastSeen: sample.timestamp,
    })
  }

  tick(now = Date.now()): void {
    for (const [id, flow] of this.flows) {
      const age = now - flow.lastSeen
      if (age > 15_000) this.flows.delete(id)
      else if (age > 2_500) {
        flow.rateIn = 0
        flow.rateOut = 0
      }
    }
    const totals = this.wanTotals()
    this.historyIn.push(totals.rateIn)
    this.historyOut.push(totals.rateOut)
    if (this.historyIn.length > 60) this.historyIn.shift()
    if (this.historyOut.length > 60) this.historyOut.shift()
  }

  list(): ClassifiedFlow[] {
    return [...this.flows.values()]
  }

  processes(): ProcessAggregate[] {
    const aggregates = new Map<number, ProcessAggregate>()
    for (const flow of this.flows.values()) {
      const existing = aggregates.get(flow.pid)
      if (!existing) {
        aggregates.set(flow.pid, {
          pid: flow.pid,
          process: flow.process,
          path: flow.path,
          connections: 1,
          rateIn: flow.rateIn,
          rateOut: flow.rateOut,
          bytesIn: flow.bytesIn,
          bytesOut: flow.bytesOut,
        })
        continue
      }
      existing.connections += 1
      existing.rateIn += flow.rateIn
      existing.rateOut += flow.rateOut
      existing.bytesIn += flow.bytesIn
      existing.bytesOut += flow.bytesOut
      if (PATH_PRIORITY.indexOf(flow.path) < PATH_PRIORITY.indexOf(existing.path)) existing.path = flow.path
    }
    return [...aggregates.values()]
  }

  apps(): AppSummary[] {
    if (!this.snapshot) return []
    const byProcess = new Map<
      string,
      {
        pids: Set<number>
        paths: Set<PathKind>
        proxyHops: Set<string>
        proxyProtocols: Set<string>
        interfaces: Set<string>
        tunnelOwners: Set<string>
        transports: Set<string>
        destinations: Set<string>
        regions: Set<string>
        rules: Set<string>
        proxyChains: Set<string>
        confidences: Set<Confidence>
        hasProxied: boolean
        hasDirect: boolean
        hasOverlay: boolean
        outerRateIn: number
        outerRateOut: number
        connections: number
        rateIn: number
        rateOut: number
      }
    >()

    const proxyOutboundInterfaces = new Map<string, Set<string>>()
    for (const flow of this.flows.values()) {
      if (flow.path !== "PROXY_OUTBOUND" || !flow.interfaceName) continue
      const interfaces = proxyOutboundInterfaces.get(flow.process) ?? new Set<string>()
      interfaces.add(flow.interfaceName)
      proxyOutboundInterfaces.set(flow.process, interfaces)
    }
    const controllerBySourcePort = new Map<number, ProxyControllerConnection[]>()
    for (const connection of this.getControllerSnapshot()?.connections ?? []) {
      if (!connection.sourcePort) continue
      const connections = controllerBySourcePort.get(connection.sourcePort) ?? []
      connections.push(connection)
      controllerBySourcePort.set(connection.sourcePort, connections)
    }

    for (const flow of this.flows.values()) {
      const controllerConnection = this.matchControllerConnection(flow, controllerBySourcePort)
      const app = byProcess.get(flow.process) ?? {
        pids: new Set<number>(),
        paths: new Set<PathKind>(),
        proxyHops: new Set<string>(),
        proxyProtocols: new Set<string>(),
        interfaces: new Set<string>(),
        tunnelOwners: new Set<string>(),
        transports: new Set<string>(),
        destinations: new Set<string>(),
        regions: new Set<string>(),
        rules: new Set<string>(),
        proxyChains: new Set<string>(),
        confidences: new Set<Confidence>(),
        hasProxied: false,
        hasDirect: false,
        hasOverlay: false,
        outerRateIn: 0,
        outerRateOut: 0,
        connections: 0,
        rateIn: 0,
        rateOut: 0,
      }
      byProcess.set(flow.process, app)
      app.pids.add(flow.pid)
      app.paths.add(flow.path)
      app.confidences.add(flow.confidence)
      app.connections += 1
      app.rateIn += flow.rateIn
      app.rateOut += flow.rateOut
      if (flow.path === "PROXY_OUTBOUND") {
        app.outerRateIn += flow.rateIn
        app.outerRateOut += flow.rateOut
      }
      app.transports.add(`${flow.protocol.toUpperCase()}${flow.family}`)
      if (flow.interfaceName) app.interfaces.add(flow.interfaceName)
      if (flow.path === "LOCAL_PROXY" || flow.path === "TUNNELED" || controllerConnection) app.hasProxied = true
      if (flow.path === "DIRECT" && !controllerConnection) app.hasDirect = true
      if (flow.path === "OVERLAY") app.hasOverlay = true

      if (controllerConnection) {
        const chain = controllerConnection.chains.length > 0 ? controllerConnection.chains.join(" -> ") : "DIRECT"
        app.proxyChains.add(chain)
        app.proxyHops.add(`Clash controller -> ${chain}`)
        app.proxyProtocols.add(
          ["Clash", controllerConnection.network?.toUpperCase()].filter(Boolean).join("/"),
        )
        if (controllerConnection.rule) {
          app.rules.add(
            `${controllerConnection.rule}${controllerConnection.rulePayload ? `(${controllerConnection.rulePayload})` : ""}`,
          )
        }
        const destination = controllerConnection.host || controllerConnection.destinationIp
        if (destination) app.destinations.add(destination)
        if (controllerConnection.destinationIp) {
          const region = this.publicRegion(controllerConnection.destinationIp)
          if (region) app.regions.add(region)
        }
      }

      const networkInterface = this.snapshot.interfaces.find((item) => item.name === flow.interfaceName)
      if (networkInterface?.owner && (flow.path === "TUNNELED" || flow.path === "OVERLAY")) {
        app.tunnelOwners.add(
          `${networkInterface.owner}/${networkInterface.name}${networkInterface.effectiveInterface ? ` -> ${networkInterface.effectiveInterface}` : ""}`,
        )
      }

      if (flow.path === "LOCAL_PROXY" && flow.remote.port) {
        const listener = this.snapshot.listeners.find(
          (item) => item.port === flow.remote.port && item.host === flow.remote.host,
        )
        const outbound = listener ? [...(proxyOutboundInterfaces.get(listener.process) ?? [])] : []
        app.proxyHops.add(`${flow.remote.host}:${flow.remote.port}${listener ? ` -> ${listener.process}` : ""}${outbound.length ? ` -> ${outbound.join("+")}` : ""}`)
        for (const protocol of this.proxyProtocolsFor(flow.remote.host, flow.remote.port)) {
          app.proxyProtocols.add(protocol)
        }
      } else if (!controllerConnection && flow.remote.host !== "*" && !this.isLocalAddress(flow.remote.host)) {
        app.destinations.add(flow.remote.host)
        const region = this.publicRegion(flow.remote.host)
        if (region) app.regions.add(region)
      }
    }

    return [...byProcess.entries()].map(([process, app]) => {
      const paths = [...app.paths]
      const proxied = app.hasProxied
      const direct = app.hasDirect
      const overlay = app.hasOverlay
      const routeKinds = Number(proxied) + Number(direct) + Number(overlay)
      const verdict = paths.includes("PROXY_OUTBOUND") && !proxied && !direct
        ? "ENGINE"
        : routeKinds > 1
          ? "MIXED"
          : proxied
            ? "PROXIED"
            : overlay
              ? "OVERLAY"
            : direct
              ? "DIRECT"
              : paths.every((path) => path === "LAN")
                ? "LOCAL"
                : "UNKNOWN"
      const confidence: Confidence = app.confidences.has("LOW")
        ? "LOW"
        : app.confidences.has("MEDIUM")
          ? "MEDIUM"
          : "HIGH"
      return {
        process,
        pids: [...app.pids],
        verdict,
        paths,
        connections: app.connections,
        rateIn: verdict === "ENGINE" ? app.outerRateIn : app.rateIn,
        rateOut: verdict === "ENGINE" ? app.outerRateOut : app.rateOut,
        proxyHops: [...app.proxyHops],
        proxyProtocols: [...app.proxyProtocols],
        interfaces: [...app.interfaces],
        tunnelOwners: [...app.tunnelOwners],
        transports: [...app.transports],
        destinations: [...app.destinations].slice(0, 5),
        regions: [...app.regions].slice(0, 5),
        rules: [...app.rules],
        proxyChains: [...app.proxyChains],
        confidence,
      }
    })
  }

  flowsForProcess(process: string): ClassifiedFlow[] {
    return this.list().filter((flow) => flow.process === process)
  }

  regionForHost(host: string): string | undefined {
    return this.publicRegion(host)
  }

  totals(): { rateIn: number; rateOut: number } {
    let rateIn = 0
    let rateOut = 0
    for (const flow of this.flows.values()) {
      rateIn += flow.rateIn
      rateOut += flow.rateOut
    }
    return { rateIn, rateOut }
  }

  wanTotals(): { rateIn: number; rateOut: number } {
    let rateIn = 0
    let rateOut = 0
    for (const flow of this.flows.values()) {
      if (flow.path !== "DIRECT" && flow.path !== "PROXY_OUTBOUND") continue
      if (!flow.interfaceName || !this.snapshot?.physicalInterfaces.includes(flow.interfaceName)) continue
      rateIn += flow.rateIn
      rateOut += flow.rateOut
    }
    return { rateIn, rateOut }
  }

  history(): { inbound: number[]; outbound: number[] } {
    return { inbound: [...this.historyIn], outbound: [...this.historyOut] }
  }

  private proxyProtocolsFor(host: string, port: number): string[] {
    if (!this.snapshot) return []
    const proxy = this.snapshot.proxy
    const protocols: string[] = []
    const sameHost = (candidate?: string) => candidate === host || (host === "127.0.0.1" && candidate === "localhost")
    if (proxy.httpEnabled && proxy.httpPort === port && sameHost(proxy.httpHost)) protocols.push("HTTP")
    if (proxy.httpsEnabled && proxy.httpsPort === port && sameHost(proxy.httpsHost)) protocols.push("HTTPS CONNECT")
    if (proxy.socksEnabled && proxy.socksPort === port && sameHost(proxy.socksHost)) protocols.push("SOCKS")
    return protocols.length > 0 ? protocols : ["local proxy (protocol unknown)"]
  }

  private publicRegion(host: string): string | undefined {
    return this.isLocalAddress(host) ? undefined : this.regionLookup(host)
  }

  private isLocalAddress(host: string): boolean {
    if (isIP(host) === 0) return false
    return (
      host === "127.0.0.1" ||
      host === "::1" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^198\.(18|19)\./.test(host) ||
      /^::ffff:0:c6(?:12|13):/i.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
      /^fe80:/i.test(host) ||
      /^f[cd][0-9a-f]{2}:/i.test(host)
    )
  }

  private matchControllerConnection(
    flow: FlowSample,
    byPort: Map<number, ProxyControllerConnection[]>,
  ): ProxyControllerConnection | undefined {
    if (!flow.local.port) return undefined
    const candidates = byPort.get(flow.local.port) ?? []
    const normalized = flow.process.toLowerCase().replace(/\.exe$/, "")
    return candidates.find((candidate) => {
      if (!candidate.process && !candidate.sourceIp && !candidate.network) return false
      if (candidate.network && candidate.network.toLowerCase() !== flow.protocol) return false
      if (candidate.sourceIp && !this.sameEndpointHost(candidate.sourceIp, flow.local.host)) return false
      const controllerProcess = candidate.process?.toLowerCase().replace(/\.exe$/, "")
      return !controllerProcess || (
        controllerProcess === normalized ||
        controllerProcess.startsWith(normalized) ||
        normalized.startsWith(controllerProcess)
      )
    })
  }

  private sameEndpointHost(left: string, right: string): boolean {
    if (left.toLowerCase() === right.toLowerCase()) return true
    const loopback = new Set(["127.0.0.1", "::1", "localhost"])
    return loopback.has(left.toLowerCase()) && loopback.has(right.toLowerCase())
  }
}
