import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  dim,
  fg,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core"
import type { AppSummary, ClassifiedFlow, NetworkSnapshot, PacketEvidence, PathKind } from "./domain"
import { knownProxyProcess } from "./classifier"
import { saveConfig, type Language } from "./config"
import { fit, formatRate, pathLabel, sparkline } from "./format"
import { FlowStore } from "./store"

type View = "apps" | "topology" | "flows" | "diagnostics" | "settings"

const COLOR = {
  background: "#071014",
  panel: "#09171c",
  detailPanel: "#151207",
  text: "#dbeafe",
  bright: "#f8fafc",
  muted: "#78909c",
  divider: "#42606b",
  label: "#67e8f9",
  labelBackground: "#0d2831",
  header: "#f8fafc",
  headerBackground: "#16404c",
  alternateRow: "#0b1b21",
  selectedRow: "#244b58",
  cyan: "#38bdf8",
  green: "#4ade80",
  amber: "#fbbf24",
  orange: "#fb923c",
  red: "#fb7185",
  purple: "#c084fc",
  indigo: "#a5b4fc",
  pink: "#f472b6",
  lime: "#a3e635",
} as const

interface ChunkStyle {
  bold?: boolean
  dim?: boolean
  background?: string
}

function styled(value: string, color: string = COLOR.text, style: ChunkStyle = {}): TextChunk {
  let chunk = fg(color)(value)
  if (style.bold) chunk = bold(chunk)
  if (style.dim) chunk = dim(chunk)
  if (style.background) chunk = bg(style.background)(chunk)
  return chunk
}

function styledLines(lines: TextChunk[][]): StyledText {
  const chunks: TextChunk[] = []
  lines.forEach((line, index) => {
    chunks.push(...line)
    if (index < lines.length - 1) chunks.push(styled("\n"))
  })
  return new StyledText(chunks)
}

function paintRow(chunks: TextChunk[], background?: string): TextChunk[] {
  return background ? chunks.map((chunk) => bg(background)(chunk)) : chunks
}

function rowBackground(index: number, selected = false): string | undefined {
  if (selected) return COLOR.selectedRow
  return index % 2 === 1 ? COLOR.alternateRow : undefined
}

function fitRight(value: string, width: number): string {
  if (value.length > width) return fit(value, width)
  return value.padStart(width)
}

function cell(
  value: string,
  width: number,
  color: string = COLOR.text,
  style: ChunkStyle & { align?: "left" | "right" } = {},
): TextChunk {
  const content = style.align === "right" ? fitRight(value, width) : fit(value, width)
  return styled(content, color, style)
}

function columnDivider(): TextChunk {
  return styled(" │ ", COLOR.divider, { dim: true })
}

function tableHeader(values: Array<[string, number, ("left" | "right")?]>): TextChunk[] {
  const chunks: TextChunk[] = []
  values.forEach(([value, width, align], index) => {
    if (index > 0) chunks.push(columnDivider())
    chunks.push(cell(value, width, COLOR.header, { bold: true, align }))
  })
  return paintRow(chunks, COLOR.headerBackground)
}

function tableRule(width: number): TextChunk[] {
  return [styled("─".repeat(Math.max(1, width)), COLOR.divider, { dim: true })]
}

function labeledLine(label: string, value: string | TextChunk[], color: string = COLOR.text): TextChunk[] {
  return [
    styled(fit(label.toUpperCase(), 18), COLOR.label, { bold: true, background: COLOR.labelBackground }),
    columnDivider(),
    ...(typeof value === "string" ? [styled(value, color)] : value),
  ]
}

function verdictColor(verdict: AppSummary["verdict"]): string {
  const colors: Record<AppSummary["verdict"], string> = {
    PROXIED: COLOR.green,
    DIRECT: COLOR.red,
    MIXED: COLOR.amber,
    OVERLAY: COLOR.purple,
    ENGINE: COLOR.cyan,
    LOCAL: COLOR.lime,
    UNKNOWN: COLOR.muted,
  }
  return colors[verdict]
}

function pathColor(path: PathKind): string {
  const colors: Record<PathKind, string> = {
    LOCAL_PROXY: COLOR.green,
    TUNNELED: COLOR.purple,
    DIRECT: COLOR.red,
    PROXY_OUTBOUND: COLOR.cyan,
    OVERLAY: COLOR.purple,
    LAN: COLOR.lime,
    BYPASSED: COLOR.orange,
    UNKNOWN: COLOR.muted,
  }
  return colors[path]
}

function interfaceColor(interfaceName: string): string {
  if (interfaceName.startsWith("utun")) return COLOR.purple
  if (interfaceName === "lo0") return COLOR.lime
  if (interfaceName === "-" || interfaceName === "unresolved") return COLOR.muted
  return COLOR.amber
}

function topologyKindColor(kind: string): string {
  if (kind.includes("PROXY")) return COLOR.green
  if (kind.includes("VPN") || kind === "TUNNEL") return COLOR.purple
  if (kind === "ZEROTIER") return COLOR.indigo
  if (kind === "PHYSICAL") return COLOR.amber
  return COLOR.cyan
}

function stateColor(state: string): string {
  if (/inactive|disconnected|disabled|offline|error/i.test(state)) return COLOR.red
  if (/active|connected|enabled|listening|online|ok/i.test(state)) return COLOR.green
  return COLOR.amber
}

function targetColor(target: string): string {
  if (target === "-" || /unknown|none/i.test(target)) return COLOR.muted
  if (/hidden/i.test(target)) return COLOR.amber
  return COLOR.green
}

function geoColor(status: string): string {
  return /^ready\b/i.test(status) ? COLOR.green : COLOR.amber
}

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
  language: Language
  settingsStatus: string
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
    language: "en",
    settingsStatus: "loaded",
  }

  constructor(
    private readonly store: FlowStore,
    private readonly geoStatus: string,
    initialLanguage: Language = "en",
  ) {
    this.state.language = initialLanguage
  }

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
      backgroundColor: COLOR.background,
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
      backgroundColor: COLOR.background,
    })
    const statusBox = new BoxRenderable(renderer, {
      width: "100%",
      height: 8,
      border: true,
      borderStyle: "rounded",
      borderColor: "#2dd4bf",
      title: " proxytop / application proxy locator ",
      titleColor: "#5eead4",
      backgroundColor: COLOR.panel,
      paddingX: 1,
    })
    this.statusText = new TextRenderable(renderer, { width: "100%", height: "100%", fg: COLOR.text, wrapMode: "none" })
    statusBox.add(this.statusText)

    this.contentBox = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: "#38bdf8",
      titleColor: "#7dd3fc",
      backgroundColor: COLOR.background,
      paddingX: 1,
    })
    this.contentText = new TextRenderable(renderer, { width: "100%", height: "100%", fg: COLOR.text, wrapMode: "none" })
    this.contentBox.add(this.contentText)

    const detailBox = new BoxRenderable(renderer, {
      width: "100%",
      height: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: "#f59e0b",
      title: " explanation / evidence ",
      titleColor: "#fbbf24",
      backgroundColor: COLOR.detailPanel,
      paddingX: 1,
    })
    this.detailText = new TextRenderable(renderer, { width: "100%", height: "100%", fg: COLOR.text, wrapMode: "none" })
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
    if (key.name === "5") this.switchView("settings")
    if (this.state.view === "settings" && key.name === "l") {
      this.state.language = this.state.language === "en" ? "zh" : "en"
      this.state.settingsStatus = "saving"
      void saveConfig({ language: this.state.language })
        .then(() => {
          this.state.settingsStatus = "saved"
          this.render()
        })
        .catch((error) => {
          this.state.settingsStatus = `save failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 48)
          this.render()
        })
    }
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
          : this.state.view === "diagnostics"
            ? "configuration and uncertainty"
            : "settings and terminology guide"

    const packetStatus = this.state.packetCount > 0
      ? `${this.state.pktap}(${this.state.packetCount},${this.state.lastPacket})`
      : this.state.pktap
    const statusWidth = Math.max(20, this.renderer.width - 4)
    const collectorChunks = this.renderer.width < 120
      ? [
          styled("net=", COLOR.muted), cell(this.state.nettop, 7, COLOR.cyan, { bold: true }),
          styled("  pkt=", COLOR.muted), cell(packetStatus, 4, COLOR.purple),
          styled("  clash=", COLOR.muted), cell(this.state.clash, 6, COLOR.amber),
          styled("  geo=", COLOR.muted), cell(this.geoStatus, 4, geoColor(this.geoStatus)),
          styled(`  ${this.state.paused ? "PAUSED" : "LIVE"}`, this.state.paused ? COLOR.amber : COLOR.green, { bold: true }),
        ]
      : [
          styled("nettop=", COLOR.muted), styled(this.state.nettop, COLOR.cyan, { bold: true }),
          styled("  pktap=", COLOR.muted), styled(packetStatus, COLOR.purple),
          styled("  clash=", COLOR.muted), styled(this.state.clash, COLOR.amber),
          styled("  geo=", COLOR.muted), styled(this.geoStatus, geoColor(this.geoStatus)),
          styled(`  ${this.state.paused ? "PAUSED" : "LIVE"}`, this.state.paused ? COLOR.amber : COLOR.green, { bold: true }),
        ]
    const dnsInterfaces = [...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || "unknown"
    const statusValueWidth = Math.max(1, statusWidth - 21)
    this.statusText.content = styledLines([
      labeledLine("System proxy", fit(proxyText(snapshot), statusValueWidth).trimEnd(), proxyText(snapshot) === "disabled" ? COLOR.muted : COLOR.green),
      labeledLine("VPN stack", fit(`${vpnSummary}  |  other utun=${otherTunnels.length} (${attributedTunnels} named)  |  ZeroTier=${zeroTier.length}`, statusValueWidth).trimEnd(), vpnSummary === "none" ? COLOR.muted : COLOR.purple),
      labeledLine("Default path", fit(`${snapshot.defaultInterface || "unknown"}  |  DNS=${dnsInterfaces}`, statusValueWidth).trimEnd(), interfaceColor(snapshot.defaultInterface || "unresolved")),
      labeledLine("WAN observed", [
        styled("↓ ", COLOR.cyan, { bold: true }),
        styled(formatRate(totals.rateIn), COLOR.cyan),
        styled(` ${sparkline(history.inbound, chartWidth)}  `, COLOR.muted, { dim: true }),
        styled("↑ ", COLOR.pink, { bold: true }),
        styled(formatRate(totals.rateOut), COLOR.pink),
        styled(` ${sparkline(history.outbound, chartWidth)}`, COLOR.muted, { dim: true }),
      ]),
      labeledLine("Focus", fit(focusText, statusValueWidth).trimEnd(), focus ? verdictColor(focus.verdict) : COLOR.muted),
      labeledLine("Collectors", collectorChunks),
    ])

    if (this.state.view === "apps") this.renderApps(apps)
    else if (this.state.view === "topology") this.renderTopology(snapshot)
    else if (this.state.view === "flows") this.renderFlows()
    else if (this.state.view === "diagnostics") this.renderDiagnostics(snapshot, this.store.apps())
    else this.renderSettings()
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
    const tableWidth = Math.max(20, this.renderer.width - 4)
    const rows = Math.max(1, this.renderer.height - 22)
    const start = Math.max(0, Math.min(this.state.selected - rows + 1, Math.max(0, apps.length - rows)))
    const visibleApps = apps.slice(start, start + rows)
    if (this.renderer.width < 140) {
      const nameWidth = this.renderer.width < 95 ? 17 : 22
      const viaWidth = Math.max(8, tableWidth - nameWidth - 8 - 10 - 10 - 12)
      const lines = [
        tableHeader([["APP", nameWidth], ["STATUS", 8], ["VIA / PORT", viaWidth], ["DOWN", 10, "right"], ["UP", 10, "right"]]),
        tableRule(tableWidth),
        ...visibleApps.map((app, index) => {
          const selected = start + index === this.state.selected
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(app.process, nameWidth - 2)}`, nameWidth, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(verdictLabel(app), 8, verdictColor(app.verdict), { bold: true }),
            columnDivider(),
            cell(appVia(app), viaWidth, verdictColor(app.verdict)),
            columnDivider(),
            cell(formatRate(app.rateIn), 10, COLOR.cyan, { align: "right" }),
            columnDivider(),
            cell(formatRate(app.rateOut), 10, COLOR.pink, { align: "right" }),
          ], rowBackground(start + index, selected))
        }),
      ]
      this.contentText.content = styledLines(lines)
    } else {
      const flexibleWidth = Math.max(30, tableWidth - 92)
      const viaWidth = Math.floor(flexibleWidth * 0.62)
      const regionWidth = flexibleWidth - viaWidth
      const lines = [
        tableHeader([["APPLICATION", 22], ["VERDICT", 8], ["PROXY / TUNNEL PATH", viaWidth], ["PROTOCOL", 17], ["TARGET COUNTRY", regionWidth], ["DOWN", 10, "right"], ["UP", 10, "right"], ["CONN", 4, "right"]]),
        tableRule(tableWidth),
        ...visibleApps.map((app, index) => {
          const selected = start + index === this.state.selected
          const target = app.regions.join(",") || (app.verdict === "PROXIED" ? "hidden by proxy" : "unknown")
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(app.process, 20)}`, 22, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(verdictLabel(app), 8, verdictColor(app.verdict), { bold: true }),
            columnDivider(),
            cell(appVia(app), viaWidth, verdictColor(app.verdict)),
            columnDivider(),
            cell(appProtocol(app), 17, COLOR.indigo),
            columnDivider(),
            cell(target, regionWidth, targetColor(target)),
            columnDivider(),
            cell(formatRate(app.rateIn), 10, COLOR.cyan, { align: "right" }),
            columnDivider(),
            cell(formatRate(app.rateOut), 10, COLOR.pink, { align: "right" }),
            columnDivider(),
            cell(String(app.connections), 4, COLOR.muted, { align: "right" }),
          ], rowBackground(start + index, selected))
        }),
      ]
      this.contentText.content = styledLines(lines)
    }
    const selected = apps[this.state.selected]
    this.detailText.content = selected
      ? this.appDetail(selected)
      : styledLines([labeledLine("Application", "No matching application. Press / to change the filter.", COLOR.muted)])
  }

  private appDetail(app: AppSummary): StyledText {
    const hiddenDestination = app.proxyHops.length > 0 && app.destinations.length === 0
    const targetCountry = app.regions.join(", ") || (hiddenDestination || app.paths.includes("TUNNELED") ? "hidden by proxy/VPN; provider API required" : "unknown")
    const keys = this.renderer && this.renderer.width < 100
      ? "1-5 views  /=search  j/k=move  s=sort  p=pause  q=quit"
      : `1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  / search  j/k select  s sort(${this.state.sort})  p pause  q quit`
    return styledLines([
      labeledLine("Application", [
        styled(app.process, COLOR.bright, { bold: true }),
        styled(`  PID=${app.pids.join(",")}  `, COLOR.muted),
        styled(app.verdict, verdictColor(app.verdict), { bold: true }),
        styled(`  confidence=${app.confidence}`, COLOR.muted),
      ]),
      labeledLine("Observed path", `${app.paths.map(pathLabel).join(" + ")}  |  via=${appVia(app)}`, verdictColor(app.verdict)),
      labeledLine("Proxy / transport", `${app.proxyProtocols.join(", ") || "none observed"}  |  ${app.transports.join(", ")}`, COLOR.indigo),
      labeledLine("Controller / rule", `${app.proxyChains.join(" | ") || "not available"}  ${app.rules.join(" | ") || ""}`, app.proxyChains.length ? COLOR.green : COLOR.muted),
      labeledLine("Interfaces", `${app.interfaces.join(", ") || "unknown"}  |  tunnel=${app.tunnelOwners.join(", ") || "none/unknown"}`, interfaceColor(app.interfaces[0] || "unresolved")),
      labeledLine("Destinations", hiddenDestination ? "hidden behind local proxy" : app.destinations.join(", ") || "none", hiddenDestination ? COLOR.amber : COLOR.text),
      labeledLine("Target country", targetCountry, targetColor(targetCountry)),
      labeledLine("Keys", keys, COLOR.muted),
    ])
  }

  private renderTopology(snapshot: NetworkSnapshot): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = " 2 Topology: every detected proxy, VPN, tunnel, and virtual network "
    const compact = this.renderer.width < 130
    const tableWidth = Math.max(20, this.renderer.width - 4)
    const topologyRows: Array<[string, string, string, string, string, string]> = []
    const proxy = snapshot.proxy
    const proxyRows = [
      proxy.httpEnabled && ["SYSTEM PROXY", "HTTP", "enabled", "-", `${proxy.httpHost}:${proxy.httpPort}`],
      proxy.httpsEnabled && ["SYSTEM PROXY", "HTTPS", "enabled", "-", `${proxy.httpsHost}:${proxy.httpsPort}`],
      proxy.socksEnabled && ["SYSTEM PROXY", "SOCKS", "enabled", "-", `${proxy.socksHost}:${proxy.socksPort}`],
      proxy.pacEnabled && ["SYSTEM PROXY", "PAC/WPAD", "enabled", "-", "dynamic"],
    ].filter(Boolean) as string[][]
    for (const row of proxyRows) topologyRows.push([row[0] || "", row[1] || "", row[2] || "", row[3] || "", row[4] || "", "application opt-in"])
    const configuredPorts = new Set([proxy.httpPort, proxy.httpsPort, proxy.socksPort].filter((port): port is number => Boolean(port)))
    for (const listener of snapshot.listeners.filter((item) => knownProxyProcess(item.process) && !configuredPorts.has(item.port))) {
      topologyRows.push(["PROXY PORT", listener.process, "listening", "TCP", `${listener.host}:${listener.port}`, "protocol unknown"])
    }
    for (const vpn of snapshot.vpnServices) {
      topologyRows.push(["VPN SERVICE", vpn.name, vpn.state, vpn.interfaceName || "-", vpn.serverAddress || vpn.providerBundleId || "-", vpn.primary ? "PRIMARY" : "configured"])
    }
    for (const network of snapshot.overlayNetworks) {
      topologyRows.push(["ZEROTIER", network.name, network.status, network.interfaceName, network.addresses.join(",") || network.id, network.routes.join(",")])
    }
    for (const item of snapshot.interfaces.filter((entry) => ["physical", "vpn", "tunnel", "zerotier"].includes(entry.kind) && (entry.status === "active" || entry.kind !== "physical"))) {
      if (item.kind === "zerotier" && snapshot.overlayNetworks.some((network) => network.interfaceName === item.name)) continue
      topologyRows.push([item.kind.toUpperCase(), item.owner || "unattributed", item.status, item.name, item.addresses.join(",") || "-", [item.isDefault ? "DEFAULT" : "", item.carriesDns ? "DNS" : "", item.effectiveInterface ? `over ${item.effectiveInterface}` : ""].filter(Boolean).join(" ")])
    }
    const rows = Math.max(1, this.renderer.height - 22)
    const maxStart = Math.max(0, topologyRows.length - rows)
    this.state.selected = Math.min(this.state.selected, maxStart)
    const visibleRows = topologyRows.slice(this.state.selected, this.state.selected + rows)
    if (compact) {
      const addressWidth = Math.max(8, tableWidth - 10 - 18 - 9 - 9 - 12)
      this.contentText.content = styledLines([
        tableHeader([["KIND", 10], ["NAME / OWNER", 18], ["STATE", 9], ["DEVICE", 9], ["ADDRESS / ROLE", addressWidth]]),
        tableRule(tableWidth),
        ...visibleRows.map(([kind, owner, state, device, address, role], index) => paintRow([
          cell(kind, 10, topologyKindColor(kind), { bold: true }),
          columnDivider(),
          cell(owner, 18, owner === "unattributed" ? COLOR.muted : COLOR.bright),
          columnDivider(),
          cell(state, 9, stateColor(state), { bold: true }),
          columnDivider(),
          cell(device, 9, interfaceColor(device)),
          columnDivider(),
          cell(`${address} ${role}`.trim(), addressWidth, COLOR.indigo),
        ], rowBackground(this.state.selected + index))),
      ])
    } else {
      const roleWidth = Math.max(8, tableWidth - 104)
      this.contentText.content = styledLines([
        tableHeader([["KIND", 12], ["NAME / OWNER", 24], ["STATE", 11], ["DEVICE", 10], ["ENDPOINT / ADDRESS", 32], ["ROLE", roleWidth]]),
        tableRule(tableWidth),
        ...visibleRows.map(([kind, owner, state, device, address, role], index) => paintRow([
          cell(kind, 12, topologyKindColor(kind), { bold: true }),
          columnDivider(),
          cell(owner, 24, owner === "unattributed" ? COLOR.muted : COLOR.bright),
          columnDivider(),
          cell(state, 11, stateColor(state), { bold: true }),
          columnDivider(),
          cell(device, 10, interfaceColor(device)),
          columnDivider(),
          cell(address, 32, COLOR.indigo),
          columnDivider(),
          cell(role, roleWidth, role ? COLOR.amber : COLOR.muted),
        ], rowBackground(this.state.selected + index))),
      ])
    }
    const unknown = snapshot.interfaces.filter((item) => item.kind === "tunnel" && !item.owner)
    this.detailText.content = styledLines([
      labeledLine("Inventory", `VPN services=${snapshot.vpnServices.length}  |  attributed=${snapshot.interfaces.filter((item) => item.kind === "vpn").length}  |  unknown utun=${unknown.length}`, COLOR.purple),
      labeledLine("System proxy", "Compatible applications may opt in; configuration alone does not prove usage.", COLOR.green),
      labeledLine("VPN mapping", "scutil service → utun is high confidence; a bare utun remains unattributed.", COLOR.purple),
      labeledLine("ZeroTier", "feth attribution uses the vendor-specific MacEthernetTapAgent interface number.", COLOR.indigo),
      labeledLine("Proxy engines", "ENGINE destinations cannot always be joined back to one local-proxy application.", COLOR.cyan),
      labeledLine("Routing", `default=${snapshot.defaultInterface || "unknown"}  |  DNS=${[...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || "unknown"}`, interfaceColor(snapshot.defaultInterface || "unresolved")),
      labeledLine("Keys", this.renderer.width < 100 ? "j/k scroll  1-5 views  q quit" : "j/k scroll  1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  q quit", COLOR.muted),
    ])
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
    const tableWidth = Math.max(20, this.renderer.width - 4)
    const rows = Math.max(1, this.renderer.height - 22)
    const start = Math.max(0, Math.min(this.state.selected - rows + 1, Math.max(0, flows.length - rows)))
    const visibleFlows = flows.slice(start, start + rows)
    if (this.renderer.width < 125) {
      const remoteWidth = Math.max(8, tableWidth - 17 - 8 - 8 - 7 - 12)
      const lines = [
        tableHeader([["PROCESS", 17], ["PATH", 8], ["VIA", 8], ["REMOTE", remoteWidth], ["TARGET", 7]]),
        tableRule(tableWidth),
        ...visibleFlows.map((flow, index) => {
          const selected = start + index === this.state.selected
          const target = this.store.regionForHost(flow.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(flow.path) ? "hidden" : "-")
          const interfaceName = flow.interfaceName || "-"
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(flow.process, 15)}`, 17, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(pathLabel(flow.path), 8, pathColor(flow.path), { bold: true }),
            columnDivider(),
            cell(interfaceName, 8, interfaceColor(interfaceName)),
            columnDivider(),
            cell(flow.remote.raw, remoteWidth, COLOR.indigo),
            columnDivider(),
            cell(target, 7, targetColor(target)),
          ], rowBackground(start + index, selected))
        }),
      ]
      this.contentText.content = styledLines(lines)
    } else {
      const remoteWidth = Math.max(8, tableWidth - 94)
      const lines = [
        tableHeader([["PROCESS", 20], ["PATH", 8], ["IFACE", 8], ["TRANSPORT", 9], ["REMOTE", remoteWidth], ["TARGET", 8], ["DOWN", 10, "right"], ["UP", 10, "right"]]),
        tableRule(tableWidth),
        ...visibleFlows.map((flow, index) => {
          const selected = start + index === this.state.selected
          const target = this.store.regionForHost(flow.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(flow.path) ? "hidden" : "-")
          const interfaceName = flow.interfaceName || "-"
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(flow.process, 18)}`, 20, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(pathLabel(flow.path), 8, pathColor(flow.path), { bold: true }),
            columnDivider(),
            cell(interfaceName, 8, interfaceColor(interfaceName)),
            columnDivider(),
            cell(`${flow.protocol.toUpperCase()}${flow.family}`, 9, COLOR.indigo),
            columnDivider(),
            cell(flow.remote.raw, remoteWidth, COLOR.bright),
            columnDivider(),
            cell(target, 8, targetColor(target)),
            columnDivider(),
            cell(formatRate(flow.rateIn), 10, COLOR.cyan, { align: "right" }),
            columnDivider(),
            cell(formatRate(flow.rateOut), 10, COLOR.pink, { align: "right" }),
          ], rowBackground(start + index, selected))
        }),
      ]
      this.contentText.content = styledLines(lines)
    }
    const selected = flows[this.state.selected]
    const selectedTarget = selected
      ? this.store.regionForHost(selected.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(selected.path) ? "hidden by proxy/VPN" : "unknown")
      : "unknown"
    this.detailText.content = selected
      ? styledLines([
          labeledLine("Process", [styled(selected.process, COLOR.bright, { bold: true }), styled(`  PID=${selected.pid}`, COLOR.muted)]),
          labeledLine("Endpoints", `${selected.local.raw}  →  ${selected.remote.raw}`, COLOR.indigo),
          labeledLine("Classification", [
            styled(`${selected.path}  |  confidence=${selected.confidence}  |  interface=${selected.interfaceName || "unknown"}`, pathColor(selected.path)),
            styled("  |  country=", COLOR.muted),
            styled(selectedTarget, targetColor(selectedTarget)),
          ]),
          labeledLine("Metrics", `state=${selected.state || "-"}  RTT=${selected.rttMs?.toFixed(1) || "-"}ms  ↓ ${formatRate(selected.rateIn)}  ↑ ${formatRate(selected.rateOut)}`, COLOR.cyan),
          ...selected.evidence.slice(0, 3).map((evidence, index) => labeledLine(index === 0 ? "Evidence" : "", evidence, COLOR.amber)),
          labeledLine("Keys", `/ search  j/k select  s sort(${this.state.sort})  p pause  q quit`, COLOR.muted),
        ])
      : styledLines([labeledLine("Flow", "No matching flow.", COLOR.muted)])
  }

  private renderDiagnostics(snapshot: NetworkSnapshot, apps: AppSummary[]): void {
    if (!this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = " 4 Diagnostics: configuration, DNS, and uncertainty "
    const direct = apps.filter((app) => app.verdict === "DIRECT").map((app) => app.process)
    const mixed = apps.filter((app) => app.verdict === "MIXED").map((app) => app.process)
    const unknown = apps.filter((app) => app.verdict === "UNKNOWN").map((app) => app.process)
    const controller = this.store.getControllerSnapshot()
    this.contentText.content = styledLines([
      labeledLine("System proxy", proxyText(snapshot), proxyText(snapshot) === "disabled" ? COLOR.muted : COLOR.green),
      labeledLine("Proxy exclusions", snapshot.proxy.exceptions.join(", ") || "none", COLOR.muted),
      labeledLine("Connected VPNs", snapshot.vpnServices.filter((item) => item.state === "Connected").map((item) => `${item.name}/${item.interfaceName}`).join(", ") || "none", COLOR.purple),
      labeledLine("Unknown tunnels", snapshot.interfaces.filter((item) => item.kind === "tunnel" && !item.owner).map((item) => item.name).join(", ") || "none", COLOR.amber),
      labeledLine("ZeroTier", snapshot.overlayNetworks.map((item) => `${item.name}[${item.id}]/${item.interfaceName}/${item.status}`).join(", ") || "none", COLOR.indigo),
      labeledLine("DNS resolvers", snapshot.dnsResolvers.map((item) => `${item.servers.join("+")}@${item.interfaceName || "global"}${item.scoped ? " scoped" : ""}`).join(" | ") || "unknown", COLOR.cyan),
      labeledLine("DIRECT apps", direct.join(", ") || "none observed", direct.length ? COLOR.red : COLOR.muted),
      labeledLine("MIXED apps", mixed.join(", ") || "none observed", mixed.length ? COLOR.amber : COLOR.muted),
      labeledLine("UNKNOWN apps", unknown.join(", ") || "none observed", COLOR.muted),
      labeledLine("Collector errors", snapshot.errors.join(" | ") || "none", snapshot.errors.length ? COLOR.red : COLOR.green),
      labeledLine("Geo database", this.geoStatus, geoColor(this.geoStatus)),
      labeledLine("Clash controller", controller ? `${controller.url} (${controller.connections.length} connections)` : "not connected", controller ? COLOR.green : COLOR.muted),
      labeledLine("Privileged pktap", `${this.state.pktap}  |  packets=${this.state.packetCount}  |  last=${this.state.lastPacket}`, this.state.packetCount ? COLOR.purple : COLOR.muted),
    ])
    this.detailText.content = styledLines([
      labeledLine("PROXIED", "Observed local proxy hop or an attributed active VPN interface.", COLOR.green),
      labeledLine("DIRECT", "Physical-interface connection with no observed local proxy hop.", COLOR.red),
      labeledLine("MIXED", "The same application has both proxied and direct flows; inspect it.", COLOR.amber),
      labeledLine("Local proxies", "Targets and selected nodes stay hidden unless a compatible controller provides the join.", COLOR.indigo),
      labeledLine("Shadowrocket", "No equivalent stable public Controller API is available for exact rule/node chains.", COLOR.purple),
      labeledLine("Geo data", "Country labels indicate IP allocation and may not equal physical location.", COLOR.cyan),
      labeledLine("Keys", "1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  q quit", COLOR.muted),
    ])
  }

  private renderSettings(): void {
    if (!this.contentBox || !this.contentText || !this.detailText) return
    const chinese = this.state.language === "zh"
    this.contentBox.title = chinese ? " 5 设置 / README：术语说明 " : " 5 Settings / README: terminology guide "
    const rows = chinese
      ? [
          ["PROXIED", "观察到应用连接了本地代理，或使用了已识别的 VPN/TUN 路径。", COLOR.green],
          ["DIRECT", "应用通过物理网卡直连，未观察到本地代理跳转。", COLOR.red],
          ["MIXED", "同一个应用同时出现代理连接和直连连接。", COLOR.amber],
          ["OVERLAY", "流量经过 ZeroTier 等覆盖网络接口。", COLOR.purple],
          ["ENGINE", "这是代理引擎本身的外层连接，不一定代表某个应用的最终连接。", COLOR.cyan],
          ["UNKNOWN", "证据不足，程序不会猜测流量最终走向。", COLOR.muted],
          ["PROXY / TUN", "PROXY 是本地代理端口；TUN 是 VPN 或隧道接口。", COLOR.indigo],
          ["WAN observed", "只统计物理网卡上的直连和代理引擎外层流量，避免重复计算。", COLOR.cyan],
          ["hidden", "本地代理或 TUN 隐藏了最终节点；需要兼容的 Clash/Mihomo API 才能显示。", COLOR.amber],
          ["confidence", "HIGH/MEDIUM/LOW 表示证据强度，不是网络速度。", COLOR.purple],
        ] as Array<[string, string, string]>
      : [
          ["PROXIED", "A local proxy hop or an attributed VPN/TUN path was observed.", COLOR.green],
          ["DIRECT", "The application uses a physical interface without an observed local proxy hop.", COLOR.red],
          ["MIXED", "The same application has both proxied and direct connections.", COLOR.amber],
          ["OVERLAY", "Traffic uses an overlay interface such as ZeroTier.", COLOR.purple],
          ["ENGINE", "This is an outer connection from the proxy engine itself.", COLOR.cyan],
          ["UNKNOWN", "Evidence is insufficient; proxytop does not guess the route.", COLOR.muted],
          ["PROXY / TUN", "PROXY means a local proxy port; TUN means a VPN or tunnel interface.", COLOR.indigo],
          ["WAN observed", "Only physical-interface direct and proxy-engine traffic is counted to avoid duplicates.", COLOR.cyan],
          ["hidden", "A local proxy or TUN hides the final node; a compatible Clash/Mihomo API is needed.", COLOR.amber],
          ["confidence", "HIGH/MEDIUM/LOW describes evidence strength, not network speed.", COLOR.purple],
        ] as Array<[string, string, string]>
    this.contentText.content = styledLines([
      labeledLine(chinese ? "语言" : "Language", `${chinese ? "中文" : "English"}  (${this.state.settingsStatus}; ${chinese ? "按 l 切换到 English" : "press l to switch to Chinese"})`, COLOR.green),
      labeledLine(chinese ? "说明" : "Guide", chinese ? "这些术语描述观察到的网络证据，不等同于绝对保证。" : "These terms describe observed network evidence, not absolute guarantees.", COLOR.text),
      ...rows.map(([term, explanation, color]) => labeledLine(term, explanation, color)),
    ])
    this.detailText.content = styledLines([
      labeledLine(chinese ? "视图" : "Views", chinese ? "1 应用  2 拓扑  3 连接  4 诊断  5 设置" : "1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings", COLOR.muted),
      labeledLine(chinese ? "操作" : "Controls", chinese ? "l 切换语言  j/k 移动  / 搜索  s 排序  p 暂停  q 退出" : "l switch language  j/k move  / search  s sort  p pause  q quit", COLOR.muted),
      labeledLine(chinese ? "重要提示" : "Important", chinese ? "DIRECT 不自动表示泄漏；UNKNOWN 表示当前证据不足。" : "DIRECT does not automatically mean a leak; UNKNOWN means evidence is incomplete.", COLOR.amber),
    ])
  }

  private searchLabel(): string {
    if (this.state.searching) return `[search: ${this.state.filter}_]`
    return this.state.filter ? `[filter: ${this.state.filter}]` : ""
  }
}
