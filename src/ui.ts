import {
  BoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"
import type { AppSummary, ClassifiedFlow, NetworkSnapshot, PacketEvidence } from "./domain"
import { knownProxyProcess } from "./classifier"
import { fit, formatRate, pathLabel, sparkline } from "./format"
import { FlowStore } from "./store"

type View = "apps" | "topology" | "flows" | "diagnostics"

interface UiState {
  nettop: string
  pktap: string
  clash: string
  packetCount: number
  lastPacket: string
  paused: boolean
  sort: "speed" | "process" | "path"
  selected: number
  view: View
  filter: string
  searching: boolean
}

function proxyText(snapshot: NetworkSnapshot): string {
  const proxy = snapshot.proxy
  const values: string[] = []
  if (proxy.httpEnabled) values.push(`HTTP ${proxy.httpHost}:${proxy.httpPort}`)
  if (proxy.httpsEnabled) values.push(`HTTPS ${proxy.httpsHost}:${proxy.httpsPort}`)
  if (proxy.socksEnabled) values.push(`SOCKS ${proxy.socksHost}:${proxy.socksPort}`)
  if (proxy.pacEnabled) values.push("PAC")
  return values.join(" + ") || "disabled"
}

function verdictLabel(app: AppSummary): string {
  const labels: Record<AppSummary["verdict"], string> = {
    PROXIED: "PROXIED",
    DIRECT: "DIRECT",
    MIXED: "MIXED!",
    OVERLAY: "OVERLAY",
    ENGINE: "ENGINE",
    LOCAL: "LOCAL",
    UNKNOWN: "UNKNOWN",
  }
  return labels[app.verdict]
}

function appVia(app: AppSummary): string {
  if (app.proxyHops.length) return app.proxyHops.join(", ")
  if (app.tunnelOwners.length) return app.tunnelOwners.join(", ")
  return app.interfaces.join(", ") || "unresolved"
}

function appProtocol(app: AppSummary): string {
  const protocols = [...app.proxyProtocols, ...app.transports]
  return [...new Set(protocols)].join(", ") || "-"
}

function sortApps(apps: AppSummary[], sort: UiState["sort"]): AppSummary[] {
  const verdictPriority: Record<AppSummary["verdict"], number> = {
    MIXED: 0,
    DIRECT: 1,
    UNKNOWN: 2,
    PROXIED: 3,
    OVERLAY: 4,
    ENGINE: 5,
    LOCAL: 6,
  }
  return apps.sort((left, right) => {
    if (sort === "process") return left.process.localeCompare(right.process)
    if (sort === "path") {
      return verdictPriority[left.verdict] - verdictPriority[right.verdict] || right.rateIn + right.rateOut - (left.rateIn + left.rateOut)
    }
    return right.rateIn + right.rateOut - (left.rateIn + left.rateOut)
  })
}

function sortFlows(flows: ClassifiedFlow[], sort: UiState["sort"]): ClassifiedFlow[] {
  return flows.sort((left, right) => {
    if (sort === "process") return left.process.localeCompare(right.process)
    if (sort === "path") return left.path.localeCompare(right.path)
    return right.rateIn + right.rateOut - (left.rateIn + left.rateOut)
  })
}

export class Dashboard {
  private renderer?: CliRenderer
  private contentBox?: BoxRenderable
  private statusText?: TextRenderable
  private contentText?: TextRenderable
  private detailText?: TextRenderable
  private timer?: ReturnType<typeof setInterval>
  private state: UiState = {
    nettop: "starting",
    pktap: "off",
    clash: "not detected",
    packetCount: 0,
    lastPacket: "-",
    paused: false,
    sort: "path",
    selected: 0,
    view: "apps",
    filter: "",
    searching: false,
  }

  constructor(
    private readonly store: FlowStore,
    private readonly geoStatus: string,
  ) {}

  setNettopStatus(status: string): void {
    this.state.nettop = status.slice(0, 48)
  }

  setPktapStatus(status: string): void {
    this.state.pktap = status.slice(0, 48)
  }

  setClashStatus(status: string): void {
    this.state.clash = status.slice(0, 48)
  }

  addPacket(packet: PacketEvidence): void {
    this.state.packetCount += 1
    this.state.lastPacket = [packet.process || "kernel", packet.interfaceName || "?", packet.direction || "?"].join("/")
  }

  async run(onDestroy: () => void): Promise<void> {
    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      screenMode: "alternate-screen",
      consoleMode: "disabled",
      targetFps: 30,
      backgroundColor: "#071014",
    })
    const renderer = this.renderer
    try {
      this.build(renderer)
      this.render()
      this.timer = setInterval(() => {
        if (!this.state.paused) this.render()
      }, 500)
      renderer.keyInput.on("keypress", (key) => this.onKey(key))
      renderer.on("resize", () => this.render())
      await new Promise<void>((resolve) => renderer.once("destroy", resolve))
    } finally {
      if (this.timer) clearInterval(this.timer)
      if (!renderer.isDestroyed) renderer.destroy()
      onDestroy()
    }
  }

  private build(renderer: CliRenderer): void {
    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#071014",
    })
    const statusBox = new BoxRenderable(renderer, {
      width: "100%",
      height: 8,
      border: true,
      borderStyle: "rounded",
      borderColor: "#2dd4bf",
      title: " proxytop / application proxy locator ",
      titleColor: "#5eead4",
      paddingX: 1,
    })
    this.statusText = new TextRenderable(renderer, { width: "100%", height: "100%", fg: "#d5f5ef" })
    statusBox.add(this.statusText)

    this.contentBox = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: "#38bdf8",
      titleColor: "#7dd3fc",
      paddingX: 1,
    })
    this.contentText = new TextRenderable(renderer, { width: "100%", height: "100%", fg: "#dbeafe" })
    this.contentBox.add(this.contentText)

    const detailBox = new BoxRenderable(renderer, {
      width: "100%",
      height: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: "#f59e0b",
      title: " explanation / evidence ",
      titleColor: "#fbbf24",
      paddingX: 1,
    })
    this.detailText = new TextRenderable(renderer, { width: "100%", height: "100%", fg: "#fef3c7" })
    detailBox.add(this.detailText)
    root.add(statusBox)
    root.add(this.contentBox)
    root.add(detailBox)
    renderer.root.add(root)
  }

  private onKey(key: KeyEvent): void {
    if (this.state.searching) {
      if (key.name === "escape") {
        this.state.searching = false
        this.state.filter = ""
      } else if (key.name === "return" || key.name === "enter") {
        this.state.searching = false
      } else if (key.name === "backspace") {
        this.state.filter = this.state.filter.slice(0, -1)
      } else if (key.sequence.length === 1 && !key.ctrl && !key.meta) {
        this.state.filter += key.sequence
      }
      this.state.selected = 0
      this.render()
      return
    }
    if (key.name === "q") return this.renderer?.destroy()
    if (key.name === "1") this.switchView("apps")
    if (key.name === "2") this.switchView("topology")
    if (key.name === "3") this.switchView("flows")
    if (key.name === "4") this.switchView("diagnostics")
    if (key.name === "/" || key.name === "slash" || key.sequence === "/") {
      this.state.searching = true
      this.state.filter = ""
    }
    if (key.name === "p" || key.name === "space") this.state.paused = !this.state.paused
    if (key.name === "s") {
      this.state.sort = this.state.sort === "speed" ? "process" : this.state.sort === "process" ? "path" : "speed"
    }
    if (key.name === "down" || key.name === "j") this.state.selected += 1
    if (key.name === "up" || key.name === "k") this.state.selected = Math.max(0, this.state.selected - 1)
    this.render()
  }

  private switchView(view: View): void {
    this.state.view = view
    this.state.selected = 0
  }

  private render(): void {
    if (!this.renderer || !this.statusText || !this.contentText || !this.detailText || !this.contentBox) return
    const snapshot = this.store.getSnapshot()
    if (!snapshot) return
    const totals = this.store.wanTotals()
    const history = this.store.history()
    const apps = this.filteredApps()
    const chartWidth = Math.max(8, Math.min(28, this.renderer.width - 88))
    const vpnSummary = snapshot.vpnServices
      .filter((service) => service.state === "Connected")
      .map((service) => `${service.name}/${service.interfaceName || "?"}${service.primary ? "*" : ""}`)
      .join(", ") || "none"
    const otherTunnels = snapshot.interfaces.filter((item) => item.kind === "tunnel")
    const attributedTunnels = otherTunnels.filter((item) => item.owner).length
    const zeroTier = snapshot.overlayNetworks.map((item) => `${item.name}/${item.interfaceName}`)
    if (this.state.view === "apps") {
      this.state.selected = Math.min(this.state.selected, Math.max(0, apps.length - 1))
    }
    const focus = this.state.view === "apps" ? apps[this.state.selected] : undefined
    const focusText = this.state.view === "apps"
      ? focus
        ? `${focus.process}: ${focus.verdict} via ${appVia(focus)} region=${focus.regions.join(",") || (focus.verdict === "PROXIED" ? "hidden" : "unknown")}`
        : "select an app"
      : this.state.view === "topology"
        ? "complete local network topology"
        : this.state.view === "flows"
          ? "raw connection evidence"
          : "configuration and uncertainty"

    const packetStatus = this.state.packetCount > 0
      ? `${this.state.pktap}(${this.state.packetCount},${this.state.lastPacket})`
      : this.state.pktap
    const statusWidth = Math.max(20, this.renderer.width - 4)
    this.statusText.content = [
      `System proxy  ${proxyText(snapshot)}`,
      `VPN stack     ${vpnSummary}  | other utun=${otherTunnels.length} (${attributedTunnels} named)  | ZeroTier=${zeroTier.length}`,
      `Default path  ${snapshot.defaultInterface || "unknown"}  | DNS=${[...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || "unknown"}`,
      `WAN observed  ↓ ${formatRate(totals.rateIn)} ${sparkline(history.inbound, chartWidth)}  ↑ ${formatRate(totals.rateOut)} ${sparkline(history.outbound, chartWidth)}`,
      `Focus         ${focusText}`,
      `Collectors    nettop=${this.state.nettop} pktap=${packetStatus} clash=${this.state.clash} geo=${this.geoStatus} ${this.state.paused ? "PAUSED" : "LIVE"}`,
    ].map((line) => fit(line, statusWidth).trimEnd()).join("\n")

    if (this.state.view === "apps") this.renderApps(apps)
    else if (this.state.view === "topology") this.renderTopology(snapshot)
    else if (this.state.view === "flows") this.renderFlows()
    else this.renderDiagnostics(snapshot, this.store.apps())
  }

  private filteredApps(): AppSummary[] {
    const needle = this.state.filter.toLowerCase()
    const apps = this.store.apps().filter((app) => !needle || app.process.toLowerCase().includes(needle))
    return sortApps(apps, this.state.sort)
  }

  private renderApps(apps: AppSummary[]): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = ` 1 Apps: is this application proxied? ${this.searchLabel()} `
    this.state.selected = Math.min(this.state.selected, Math.max(0, apps.length - 1))
    const width = this.renderer.width
    const rows = Math.max(3, this.renderer.height - 21)
    const start = Math.max(0, Math.min(this.state.selected - rows + 1, Math.max(0, apps.length - rows)))
    const visibleApps = apps.slice(start, start + rows)
    if (width < 140) {
      const nameWidth = width < 95 ? 17 : 22
      const viaWidth = Math.max(14, width - nameWidth - 33)
      this.contentText.content = [
        `${fit("APP", nameWidth)} ${fit("STATUS", 8)} ${fit("VIA / PORT", viaWidth)} ${fit("DOWN", 10)} ${fit("UP", 10)}`,
        ...visibleApps.map((app, index) =>
          `${start + index === this.state.selected ? ">" : " "}${fit(app.process, nameWidth - 1)} ${fit(verdictLabel(app), 8)} ${fit(appVia(app), viaWidth)} ${fit(formatRate(app.rateIn), 10)} ${fit(formatRate(app.rateOut), 10)}`,
        ),
      ].join("\n")
    } else {
      const viaWidth = Math.max(24, Math.floor(width * 0.25))
      const regionWidth = Math.max(10, width - viaWidth - 91)
      this.contentText.content = [
        `${fit("APPLICATION", 22)} ${fit("VERDICT", 8)} ${fit("PROXY / TUNNEL PATH", viaWidth)} ${fit("PROTOCOL", 23)} ${fit("TARGET COUNTRY", regionWidth)} ${fit("DOWN", 10)} ${fit("UP", 10)} CONN`,
        ...visibleApps.map((app, index) =>
          `${start + index === this.state.selected ? ">" : " "}${fit(app.process, 21)} ${fit(verdictLabel(app), 8)} ${fit(appVia(app), viaWidth)} ${fit(appProtocol(app), 23)} ${fit(app.regions.join(",") || (app.verdict === "PROXIED" ? "hidden by proxy" : "unknown"), regionWidth)} ${fit(formatRate(app.rateIn), 10)} ${fit(formatRate(app.rateOut), 10)} ${String(app.connections).padStart(4)}`,
        ),
      ].join("\n")
    }
    const selected = apps[this.state.selected]
    this.detailText.content = selected ? this.appDetail(selected) : "No matching application. Press / to change the filter."
  }

  private appDetail(app: AppSummary): string {
    const hiddenDestination = app.proxyHops.length > 0 && app.destinations.length === 0
    return [
      `${app.process}  PIDs=${app.pids.join(",")}  verdict=${app.verdict}  confidence=${app.confidence}`,
      `Observed path: ${app.paths.map(pathLabel).join(" + ")}  via=${appVia(app)}`,
      `Proxy protocol/config: ${app.proxyProtocols.join(", ") || "none observed"}  transport=${app.transports.join(", ")}`,
      `Controller chain/rule: ${app.proxyChains.join(" | ") || "not available"}  ${app.rules.join(" | ") || ""}`,
      `Interfaces: ${app.interfaces.join(", ") || "unknown"}  tunnel owner=${app.tunnelOwners.join(", ") || "none/unknown"}`,
      `Destinations: ${hiddenDestination ? "hidden behind local proxy" : app.destinations.join(", ") || "none"}`,
      `Target/remote country: ${app.regions.join(", ") || (hiddenDestination || app.paths.includes("TUNNELED") ? "hidden by proxy/VPN; provider API required" : "unknown")}`,
      `Keys: 1 Apps  2 Topology  3 Flows  4 Diagnostics  / search  j/k select  s sort(${this.state.sort})  p pause  q quit`,
    ].join("\n")
  }

  private renderTopology(snapshot: NetworkSnapshot): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = " 2 Topology: every detected proxy, VPN, tunnel, and virtual network "
    const compact = this.renderer.width < 110
    const addressWidth = compact ? Math.max(16, this.renderer.width - 53) : 32
    const lines = [compact
      ? `${fit("KIND", 10)} ${fit("NAME / OWNER", 18)} ${fit("STATE", 8)} ${fit("DEVICE", 9)} ${fit("ADDRESS / ROLE", addressWidth)}`
      : `${fit("KIND", 12)} ${fit("NAME / OWNER", 24)} ${fit("STATE", 11)} ${fit("DEVICE", 10)} ${fit("ENDPOINT / ADDRESS", 32)} ROLE`]
    const topologyRow = (kind: string, owner: string, state: string, device: string, address: string, role: string): string => compact
      ? `${fit(kind, 10)} ${fit(owner, 18)} ${fit(state, 8)} ${fit(device, 9)} ${fit(`${address} ${role}`.trim(), addressWidth)}`
      : `${fit(kind, 12)} ${fit(owner, 24)} ${fit(state, 11)} ${fit(device, 10)} ${fit(address, 32)} ${role}`
    const proxy = snapshot.proxy
    const proxyRows = [
      proxy.httpEnabled && ["SYSTEM PROXY", "HTTP", "enabled", "-", `${proxy.httpHost}:${proxy.httpPort}`],
      proxy.httpsEnabled && ["SYSTEM PROXY", "HTTPS", "enabled", "-", `${proxy.httpsHost}:${proxy.httpsPort}`],
      proxy.socksEnabled && ["SYSTEM PROXY", "SOCKS", "enabled", "-", `${proxy.socksHost}:${proxy.socksPort}`],
      proxy.pacEnabled && ["SYSTEM PROXY", "PAC/WPAD", "enabled", "-", "dynamic"],
    ].filter(Boolean) as string[][]
    for (const row of proxyRows) lines.push(topologyRow(row[0] || "", row[1] || "", row[2] || "", row[3] || "", row[4] || "", "application opt-in"))
    const configuredPorts = new Set([proxy.httpPort, proxy.httpsPort, proxy.socksPort].filter((port): port is number => Boolean(port)))
    for (const listener of snapshot.listeners.filter((item) => knownProxyProcess(item.process) && !configuredPorts.has(item.port))) {
      lines.push(topologyRow("PROXY PORT", listener.process, "listening", "TCP", `${listener.host}:${listener.port}`, "protocol unknown"))
    }
    for (const vpn of snapshot.vpnServices) {
      lines.push(topologyRow("VPN SERVICE", vpn.name, vpn.state, vpn.interfaceName || "-", vpn.serverAddress || vpn.providerBundleId || "-", vpn.primary ? "PRIMARY" : "configured"))
    }
    for (const network of snapshot.overlayNetworks) {
      lines.push(topologyRow("ZEROTIER", network.name, network.status, network.interfaceName, network.addresses.join(",") || network.id, network.routes.join(",")))
    }
    for (const item of snapshot.interfaces.filter((entry) => ["physical", "vpn", "tunnel", "zerotier"].includes(entry.kind) && (entry.status === "active" || entry.kind !== "physical"))) {
      if (item.kind === "zerotier" && snapshot.overlayNetworks.some((network) => network.interfaceName === item.name)) continue
      lines.push(topologyRow(item.kind.toUpperCase(), item.owner || "unattributed", item.status, item.name, item.addresses.join(",") || "-", [item.isDefault ? "DEFAULT" : "", item.carriesDns ? "DNS" : "", item.effectiveInterface ? `over ${item.effectiveInterface}` : ""].filter(Boolean).join(" ")))
    }
    const rows = Math.max(4, this.renderer.height - 21)
    const maxStart = Math.max(0, lines.length - rows)
    this.state.selected = Math.min(this.state.selected, maxStart)
    this.contentText.content = lines.slice(this.state.selected, this.state.selected + rows).join("\n")
    const unknown = snapshot.interfaces.filter((item) => item.kind === "tunnel" && !item.owner)
    this.detailText.content = [
      `Detected ${snapshot.vpnServices.length} configured VPN service(s), ${snapshot.interfaces.filter((item) => item.kind === "vpn").length} attributed VPN interface(s), ${unknown.length} unattributed utun interface(s).`,
      `System proxy means compatible applications may connect to its endpoint; it does not prove every application uses it.`,
      `A VPN service -> utun mapping from scutil is high confidence. Bare utun names without a matching service remain unattributed.`,
      `ZeroTier feth attribution uses the MacEthernetTapAgent interface number and is vendor-specific.`,
      `Proxy-engine remote countries are visible in Apps as ENGINE rows, but cannot be reliably assigned back to one local-proxy application.`,
      `Default route=${snapshot.defaultInterface || "unknown"}; DNS interfaces=${[...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || "unknown"}.`,
      `Keys: j/k scroll  1 Apps  2 Topology  3 Flows  4 Diagnostics  q quit`,
    ].join("\n")
  }

  private renderFlows(): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = ` 3 Flows: raw per-connection evidence ${this.searchLabel()} `
    const needle = this.state.filter.toLowerCase()
    const flows = sortFlows(
      this.store.list().filter((flow) => !needle || flow.process.toLowerCase().includes(needle) || flow.remote.raw.toLowerCase().includes(needle)),
      this.state.sort,
    )
    this.state.selected = Math.min(this.state.selected, Math.max(0, flows.length - 1))
    const rows = Math.max(3, this.renderer.height - 21)
    const start = Math.max(0, Math.min(this.state.selected - rows + 1, Math.max(0, flows.length - rows)))
    const visibleFlows = flows.slice(start, start + rows)
    if (this.renderer.width < 110) {
      const remoteWidth = Math.max(14, this.renderer.width - 45)
      this.contentText.content = [
        `${fit("PROCESS", 17)} ${fit("PATH", 8)} ${fit("VIA", 8)} ${fit("REMOTE", remoteWidth)} ${fit("TARGET", 7)}`,
        ...visibleFlows.map((flow, index) =>
          `${start + index === this.state.selected ? ">" : " "}${fit(flow.process, 16)} ${fit(pathLabel(flow.path), 8)} ${fit(flow.interfaceName || "-", 8)} ${fit(flow.remote.raw, remoteWidth)} ${fit(this.store.regionForHost(flow.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(flow.path) ? "hidden" : "-"), 7)}`,
        ),
      ].join("\n")
    } else {
      const remoteWidth = Math.max(16, this.renderer.width - 88)
      this.contentText.content = [
        `${fit("PROCESS", 20)} ${fit("PATH", 8)} ${fit("IFACE", 8)} ${fit("TRANSPORT", 9)} ${fit("REMOTE", remoteWidth)} ${fit("TARGET", 8)} ${fit("DOWN", 10)} ${fit("UP", 10)}`,
        ...visibleFlows.map((flow, index) =>
          `${start + index === this.state.selected ? ">" : " "}${fit(flow.process, 19)} ${fit(pathLabel(flow.path), 8)} ${fit(flow.interfaceName || "-", 8)} ${fit(`${flow.protocol.toUpperCase()}${flow.family}`, 9)} ${fit(flow.remote.raw, remoteWidth)} ${fit(this.store.regionForHost(flow.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(flow.path) ? "hidden" : "-"), 8)} ${fit(formatRate(flow.rateIn), 10)} ${fit(formatRate(flow.rateOut), 10)}`,
        ),
      ].join("\n")
    }
    const selected = flows[this.state.selected]
    this.detailText.content = selected
      ? [
          `${selected.process} pid=${selected.pid} ${selected.local.raw} -> ${selected.remote.raw}`,
          `classification=${selected.path} confidence=${selected.confidence} interface=${selected.interfaceName || "unknown"}`,
          `state=${selected.state || "-"} RTT=${selected.rttMs?.toFixed(1) || "-"}ms down=${formatRate(selected.rateIn)} up=${formatRate(selected.rateOut)}`,
          `target/remote country=${this.store.regionForHost(selected.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(selected.path) ? "hidden by proxy/VPN" : "unknown")}`,
          ...selected.evidence,
          `Keys: / search  j/k select  s sort(${this.state.sort})  p pause  q quit`,
        ].join("\n")
      : "No matching flow."
  }

  private renderDiagnostics(snapshot: NetworkSnapshot, apps: AppSummary[]): void {
    if (!this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = " 4 Diagnostics: configuration, DNS, and uncertainty "
    const direct = apps.filter((app) => app.verdict === "DIRECT").map((app) => app.process)
    const mixed = apps.filter((app) => app.verdict === "MIXED").map((app) => app.process)
    const unknown = apps.filter((app) => app.verdict === "UNKNOWN").map((app) => app.process)
    this.contentText.content = [
      `Effective system proxy: ${proxyText(snapshot)}`,
      `Proxy exclusions: ${snapshot.proxy.exceptions.join(", ") || "none"}`,
      `Connected VPNs: ${snapshot.vpnServices.filter((item) => item.state === "Connected").map((item) => `${item.name}/${item.interfaceName}`).join(", ") || "none"}`,
      `Unattributed tunnels: ${snapshot.interfaces.filter((item) => item.kind === "tunnel" && !item.owner).map((item) => item.name).join(", ") || "none"}`,
      `ZeroTier networks: ${snapshot.overlayNetworks.map((item) => `${item.name}[${item.id}]/${item.interfaceName}/${item.status}`).join(", ") || "none"}`,
      `DNS resolvers: ${snapshot.dnsResolvers.map((item) => `${item.servers.join("+")}@${item.interfaceName || "global"}${item.scoped ? " scoped" : ""}`).join(" | ") || "unknown"}`,
      `DIRECT apps: ${direct.join(", ") || "none observed"}`,
      `MIXED apps: ${mixed.join(", ") || "none observed"}`,
      `UNKNOWN apps: ${unknown.join(", ") || "none observed"}`,
      `Collector errors: ${snapshot.errors.join(" | ") || "none"}`,
      `Geo status: ${this.geoStatus}`,
      `Clash-compatible controller: ${this.store.getControllerSnapshot() ? `${this.store.getControllerSnapshot()?.url} (${this.store.getControllerSnapshot()?.connections.length} connections)` : "not connected"}`,
      `Privileged pktap: ${this.state.pktap}, packets=${this.state.packetCount}, last=${this.state.lastPacket}`,
    ].join("\n")
    this.detailText.content = [
      `PROXIED is based on an observed local proxy hop or an attributed active VPN interface. DIRECT means a physical-interface connection with no observed local proxy hop.`,
      `MIXED means the same application currently has both proxied and direct flows and deserves inspection.`,
      `For local HTTP/SOCKS proxies, the target and exact selected node are hidden from nettop unless a compatible controller provides the join.`,
      `Exact Clash/Mihomo rules and node chains require its Controller API. Shadowrocket does not expose an equivalent stable public API.`,
      `Offline IP country data labels server allocation and may not equal physical location.`,
      `Keys: 1 Apps  2 Topology  3 Flows  4 Diagnostics  q quit`,
    ].join("\n")
  }

  private searchLabel(): string {
    if (this.state.searching) return `[search: ${this.state.filter}_]`
    return this.state.filter ? `[filter: ${this.state.filter}]` : ""
  }
}
