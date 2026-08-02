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

function text(language: Language, english: string, chinese: string): string {
  return language === "zh" ? chinese : english
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

function topologyLabel(value: string, language: Language): string {
  if (language === "en") return value
  const labels: Record<string, string> = {
    "SYSTEM PROXY": "系统代理",
    "PROXY PORT": "代理端口",
    "VPN SERVICE": "VPN 服务",
    ZEROTIER: "ZeroTier",
    PHYSICAL: "物理网卡",
    VPN: "VPN",
    TUNNEL: "隧道",
    DEFAULT: "默认",
    DNS: "DNS",
    over: "经过",
    PRIMARY: "主要",
    configured: "已配置",
    listening: "监听中",
    active: "活动",
    inactive: "未活动",
    unknown: "未知",
    Connected: "已连接",
    Disconnected: "已断开",
  }
  return labels[value] || value
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

function verdictLabel(app: AppSummary, language: Language): string {
  const labels: Record<AppSummary["verdict"], [string, string]> = {
    PROXIED: ["PROXIED", "代理"],
    DIRECT: ["DIRECT", "直连"],
    MIXED: ["MIXED!", "混合"],
    OVERLAY: ["OVERLAY", "覆盖"],
    ENGINE: ["ENGINE", "引擎"],
    LOCAL: ["LOCAL", "本地"],
    UNKNOWN: ["UNKNOWN", "未知"],
  }
  return labels[app.verdict][language === "zh" ? 1 : 0]
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
      useMouse: false,
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
    if (key.name === "l") {
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
        ? `${focus.process}: ${verdictLabel(focus, this.state.language)} ${text(this.state.language, "via", "路径") } ${appVia(focus)} ${text(this.state.language, "region", "地区")}=${focus.regions.join(",") || (focus.verdict === "PROXIED" ? text(this.state.language, "hidden", "隐藏") : text(this.state.language, "unknown", "未知"))}`
        : text(this.state.language, "select an app", "请选择一个应用")
      : this.state.view === "topology"
        ? text(this.state.language, "complete local network topology", "完整的本地网络拓扑")
        : this.state.view === "flows"
          ? text(this.state.language, "raw connection evidence", "原始连接证据")
          : this.state.view === "diagnostics"
            ? text(this.state.language, "configuration and uncertainty", "配置与不确定性")
            : text(this.state.language, "settings and terminology guide", "设置与术语说明")

    const packetStatus = this.state.packetCount > 0
      ? `${this.state.pktap}(${this.state.packetCount},${this.state.lastPacket})`
      : this.state.pktap
    const statusWidth = Math.max(20, this.renderer.width - 4)
    const collectorChunks = this.renderer.width < 120
      ? [
           styled(text(this.state.language, "net=", "网络="), COLOR.muted), cell(this.state.nettop, 7, COLOR.cyan, { bold: true }),
           styled(text(this.state.language, "  pkt=", "  抓包="), COLOR.muted), cell(packetStatus, 4, COLOR.purple),
           styled("  clash=", COLOR.muted), cell(this.state.clash, 6, COLOR.amber),
           styled(text(this.state.language, "  geo=", "  地理="), COLOR.muted), cell(this.geoStatus, 4, geoColor(this.geoStatus)),
           styled(`  ${this.state.paused ? text(this.state.language, "PAUSED", "暂停") : text(this.state.language, "LIVE", "实时")}`, this.state.paused ? COLOR.amber : COLOR.green, { bold: true }),
        ]
      : [
           styled("nettop=", COLOR.muted), styled(this.state.nettop, COLOR.cyan, { bold: true }),
           styled(text(this.state.language, "  pktap=", "  抓包="), COLOR.muted), styled(packetStatus, COLOR.purple),
           styled("  clash=", COLOR.muted), styled(this.state.clash, COLOR.amber),
           styled(text(this.state.language, "  geo=", "  地理="), COLOR.muted), styled(this.geoStatus, geoColor(this.geoStatus)),
           styled(`  ${this.state.paused ? text(this.state.language, "PAUSED", "暂停") : text(this.state.language, "LIVE", "实时")}`, this.state.paused ? COLOR.amber : COLOR.green, { bold: true }),
        ]
    const dnsInterfaces = [...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || "unknown"
    const statusValueWidth = Math.max(1, statusWidth - 21)
    this.statusText.content = styledLines([
      labeledLine(text(this.state.language, "System proxy", "系统代理"), fit(proxyText(snapshot), statusValueWidth).trimEnd(), proxyText(snapshot) === "disabled" ? COLOR.muted : COLOR.green),
      labeledLine(text(this.state.language, "VPN stack", "VPN 栈"), fit(`${vpnSummary}  |  ${text(this.state.language, "other utun", "其他 utun")}=${otherTunnels.length} (${attributedTunnels} ${text(this.state.language, "named", "已命名")})  |  ZeroTier=${zeroTier.length}`, statusValueWidth).trimEnd(), vpnSummary === "none" ? COLOR.muted : COLOR.purple),
      labeledLine(text(this.state.language, "Default path", "默认路径"), fit(`${snapshot.defaultInterface || text(this.state.language, "unknown", "未知")}  |  DNS=${dnsInterfaces}`, statusValueWidth).trimEnd(), interfaceColor(snapshot.defaultInterface || "unresolved")),
      labeledLine(text(this.state.language, "WAN observed", "WAN 观测"), [
        styled("↓ ", COLOR.cyan, { bold: true }),
        styled(formatRate(totals.rateIn), COLOR.cyan),
        styled(` ${sparkline(history.inbound, chartWidth)}  `, COLOR.muted, { dim: true }),
        styled("↑ ", COLOR.pink, { bold: true }),
        styled(formatRate(totals.rateOut), COLOR.pink),
        styled(` ${sparkline(history.outbound, chartWidth)}`, COLOR.muted, { dim: true }),
      ]),
      labeledLine(text(this.state.language, "Focus", "当前焦点"), fit(focusText, statusValueWidth).trimEnd(), focus ? verdictColor(focus.verdict) : COLOR.muted),
      labeledLine(text(this.state.language, "Language", "语言"), this.state.language === "zh" ? "中文  (l = English)" : "English  (l = 中文)", COLOR.green),
      labeledLine(text(this.state.language, "Collectors", "采集器"), collectorChunks),
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
    this.contentBox.title = this.state.language === "zh"
      ? ` 1 应用：这个应用是否经过代理？ ${this.searchLabel()} `
      : ` 1 Apps: is this application proxied? ${this.searchLabel()} `
    this.state.selected = Math.min(this.state.selected, Math.max(0, apps.length - 1))
    const tableWidth = Math.max(20, this.renderer.width - 4)
    const rows = Math.max(1, this.renderer.height - 22)
    const start = Math.max(0, Math.min(this.state.selected - rows + 1, Math.max(0, apps.length - rows)))
    const visibleApps = apps.slice(start, start + rows)
    if (this.renderer.width < 140) {
      const nameWidth = this.renderer.width < 95 ? 17 : 22
      const viaWidth = Math.max(8, tableWidth - nameWidth - 8 - 10 - 10 - 12)
      const lines = [
         tableHeader([[text(this.state.language, "APP", "应用"), nameWidth], [text(this.state.language, "STATUS", "状态"), 8], [text(this.state.language, "VIA / PORT", "路径 / 端口"), viaWidth], [text(this.state.language, "DOWN", "下载"), 10, "right"], [text(this.state.language, "UP", "上传"), 10, "right"]]),
        tableRule(tableWidth),
        ...visibleApps.map((app, index) => {
          const selected = start + index === this.state.selected
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(app.process, nameWidth - 2)}`, nameWidth, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(verdictLabel(app, this.state.language), 8, verdictColor(app.verdict), { bold: true }),
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
         tableHeader([[text(this.state.language, "APPLICATION", "应用程序"), 22], [text(this.state.language, "VERDICT", "结论"), 8], [text(this.state.language, "PROXY / TUNNEL PATH", "代理 / 隧道路径"), viaWidth], [text(this.state.language, "PROTOCOL", "协议"), 17], [text(this.state.language, "TARGET COUNTRY", "目标国家"), regionWidth], [text(this.state.language, "DOWN", "下载"), 10, "right"], [text(this.state.language, "UP", "上传"), 10, "right"], [text(this.state.language, "CONN", "连接"), 4, "right"]]),
        tableRule(tableWidth),
        ...visibleApps.map((app, index) => {
          const selected = start + index === this.state.selected
           const target = app.regions.join(",") || (app.verdict === "PROXIED" ? text(this.state.language, "hidden by proxy", "代理隐藏") : text(this.state.language, "unknown", "未知"))
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(app.process, 20)}`, 22, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(verdictLabel(app, this.state.language), 8, verdictColor(app.verdict), { bold: true }),
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
      : styledLines([labeledLine(text(this.state.language, "Application", "应用程序"), text(this.state.language, "No matching application. Press / to change the filter.", "没有匹配的应用。按 / 修改筛选条件。"), COLOR.muted)])
  }

  private appDetail(app: AppSummary): StyledText {
    const hiddenDestination = app.proxyHops.length > 0 && app.destinations.length === 0
    const targetCountry = app.regions.join(", ") || (hiddenDestination || app.paths.includes("TUNNELED") ? text(this.state.language, "hidden by proxy/VPN; provider API required", "已被代理/VPN 隐藏；需要服务商 API") : text(this.state.language, "unknown", "未知"))
    const keys = this.renderer && this.renderer.width < 100
      ? text(this.state.language, "1-5 views  /=search  j/k=move  s=sort  p=pause  q=quit", "1-5 视图  /=搜索  j/k=移动  s=排序  p=暂停  q=退出")
      : text(this.state.language, `1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  / search  j/k select  s sort(${this.state.sort})  p pause  q quit`, `1 应用  2 拓扑  3 连接  4 诊断  5 设置  / 搜索  j/k 选择  s 排序(${this.state.sort})  p 暂停  q 退出`)
    return styledLines([
      labeledLine(text(this.state.language, "Application", "应用程序"), [
        styled(app.process, COLOR.bright, { bold: true }),
        styled(`  PID=${app.pids.join(",")}  `, COLOR.muted),
        styled(verdictLabel(app, this.state.language), verdictColor(app.verdict), { bold: true }),
        styled(`  ${text(this.state.language, "confidence", "置信度")}=${app.confidence}`, COLOR.muted),
      ]),
      labeledLine(text(this.state.language, "Observed path", "观测路径"), `${app.paths.map((path) => pathLabel(path, this.state.language)).join(" + ")}  |  ${text(this.state.language, "via", "路径")}=${appVia(app)}`, verdictColor(app.verdict)),
      labeledLine(text(this.state.language, "Proxy / transport", "代理 / 传输"), `${app.proxyProtocols.join(", ") || text(this.state.language, "none observed", "未观测到")}  |  ${app.transports.join(", ")}`, COLOR.indigo),
      labeledLine(text(this.state.language, "Controller / rule", "控制器 / 规则"), `${app.proxyChains.join(" | ") || text(this.state.language, "not available", "不可用")}  ${app.rules.join(" | ") || ""}`, app.proxyChains.length ? COLOR.green : COLOR.muted),
      labeledLine(text(this.state.language, "Interfaces", "网络接口"), `${app.interfaces.join(", ") || text(this.state.language, "unknown", "未知")}  |  tunnel=${app.tunnelOwners.join(", ") || text(this.state.language, "none/unknown", "无/未知")}`, interfaceColor(app.interfaces[0] || "unresolved")),
      labeledLine(text(this.state.language, "Destinations", "目标"), hiddenDestination ? text(this.state.language, "hidden behind local proxy", "被本地代理隐藏") : app.destinations.join(", ") || text(this.state.language, "none", "无"), hiddenDestination ? COLOR.amber : COLOR.text),
      labeledLine(text(this.state.language, "Target country", "目标国家"), targetCountry, targetColor(targetCountry)),
      labeledLine(text(this.state.language, "Keys", "快捷键"), keys, COLOR.muted),
    ])
  }

  private renderTopology(snapshot: NetworkSnapshot): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = this.state.language === "zh"
      ? " 2 拓扑：检测到的代理、VPN、隧道和虚拟网络 "
      : " 2 Topology: every detected proxy, VPN, tunnel, and virtual network "
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
         tableHeader([[text(this.state.language, "KIND", "类型"), 10], [text(this.state.language, "NAME / OWNER", "名称 / 所有者"), 18], [text(this.state.language, "STATE", "状态"), 9], [text(this.state.language, "DEVICE", "设备"), 9], [text(this.state.language, "ADDRESS / ROLE", "地址 / 角色"), addressWidth]]),
        tableRule(tableWidth),
        ...visibleRows.map(([kind, owner, state, device, address, role], index) => paintRow([
           cell(topologyLabel(kind, this.state.language), 10, topologyKindColor(kind), { bold: true }),
          columnDivider(),
          cell(owner, 18, owner === "unattributed" ? COLOR.muted : COLOR.bright),
          columnDivider(),
           cell(topologyLabel(state, this.state.language), 9, stateColor(state), { bold: true }),
          columnDivider(),
          cell(device, 9, interfaceColor(device)),
          columnDivider(),
           cell(`${address} ${role.split(" ").map((part) => topologyLabel(part, this.state.language)).join(" ")}`.trim(), addressWidth, COLOR.indigo),
        ], rowBackground(this.state.selected + index))),
      ])
    } else {
      const roleWidth = Math.max(8, tableWidth - 104)
      this.contentText.content = styledLines([
         tableHeader([[text(this.state.language, "KIND", "类型"), 12], [text(this.state.language, "NAME / OWNER", "名称 / 所有者"), 24], [text(this.state.language, "STATE", "状态"), 11], [text(this.state.language, "DEVICE", "设备"), 10], [text(this.state.language, "ENDPOINT / ADDRESS", "端点 / 地址"), 32], [text(this.state.language, "ROLE", "角色"), roleWidth]]),
        tableRule(tableWidth),
        ...visibleRows.map(([kind, owner, state, device, address, role], index) => paintRow([
           cell(topologyLabel(kind, this.state.language), 12, topologyKindColor(kind), { bold: true }),
          columnDivider(),
          cell(owner, 24, owner === "unattributed" ? COLOR.muted : COLOR.bright),
          columnDivider(),
           cell(topologyLabel(state, this.state.language), 11, stateColor(state), { bold: true }),
          columnDivider(),
          cell(device, 10, interfaceColor(device)),
          columnDivider(),
          cell(address, 32, COLOR.indigo),
          columnDivider(),
           cell(role.split(" ").map((part) => topologyLabel(part, this.state.language)).join(" "), roleWidth, role ? COLOR.amber : COLOR.muted),
        ], rowBackground(this.state.selected + index))),
      ])
    }
    const unknown = snapshot.interfaces.filter((item) => item.kind === "tunnel" && !item.owner)
    this.detailText.content = styledLines([
       labeledLine(text(this.state.language, "Inventory", "清单"), `${text(this.state.language, "VPN services", "VPN 服务")}=${snapshot.vpnServices.length}  |  ${text(this.state.language, "attributed", "已归属")}=${snapshot.interfaces.filter((item) => item.kind === "vpn").length}  |  ${text(this.state.language, "unknown utun", "未知 utun")}=${unknown.length}`, COLOR.purple),
       labeledLine(text(this.state.language, "System proxy", "系统代理"), text(this.state.language, "Compatible applications may opt in; configuration alone does not prove usage.", "兼容的应用可以选择使用代理；仅有配置并不能证明实际使用。"), COLOR.green),
       labeledLine(text(this.state.language, "VPN mapping", "VPN 映射"), text(this.state.language, "scutil service → utun is high confidence; a bare utun remains unattributed.", "scutil 服务到 utun 的映射置信度较高；没有归属信息的 utun 无法确定所有者。"), COLOR.purple),
       labeledLine("ZeroTier", text(this.state.language, "feth attribution uses the vendor-specific MacEthernetTapAgent interface number.", "feth 归属使用厂商特定的 MacEthernetTapAgent 接口编号。"), COLOR.indigo),
       labeledLine(text(this.state.language, "Proxy engines", "代理引擎"), text(this.state.language, "ENGINE destinations cannot always be joined back to one local-proxy application.", "ENGINE 目标不一定能关联回某一个使用本地代理的应用。"), COLOR.cyan),
       labeledLine(text(this.state.language, "Routing", "路由"), `default=${snapshot.defaultInterface || text(this.state.language, "unknown", "未知")}  |  DNS=${[...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || text(this.state.language, "unknown", "未知")}`, interfaceColor(snapshot.defaultInterface || "unresolved")),
       labeledLine(text(this.state.language, "Keys", "快捷键"), this.renderer.width < 100 ? text(this.state.language, "j/k scroll  1-5 views  q quit", "j/k 滚动  1-5 视图  q 退出") : text(this.state.language, "j/k scroll  1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  q quit", "j/k 滚动  1 应用  2 拓扑  3 连接  4 诊断  5 设置  q 退出"), COLOR.muted),
    ])
  }

  private renderFlows(): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = this.state.language === "zh"
      ? ` 3 连接：每个连接的原始证据 ${this.searchLabel()} `
      : ` 3 Flows: raw per-connection evidence ${this.searchLabel()} `
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
         tableHeader([[text(this.state.language, "PROCESS", "进程"), 17], [text(this.state.language, "PATH", "路径"), 8], [text(this.state.language, "VIA", "接口"), 8], [text(this.state.language, "REMOTE", "远端"), remoteWidth], [text(this.state.language, "TARGET", "目标"), 7]]),
        tableRule(tableWidth),
        ...visibleFlows.map((flow, index) => {
          const selected = start + index === this.state.selected
           const target = this.store.regionForHost(flow.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(flow.path) ? text(this.state.language, "hidden", "隐藏") : "-")
          const interfaceName = flow.interfaceName || "-"
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(flow.process, 15)}`, 17, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(pathLabel(flow.path, this.state.language), 8, pathColor(flow.path), { bold: true }),
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
         tableHeader([[text(this.state.language, "PROCESS", "进程"), 20], [text(this.state.language, "PATH", "路径"), 8], [text(this.state.language, "IFACE", "接口"), 8], [text(this.state.language, "TRANSPORT", "传输"), 9], [text(this.state.language, "REMOTE", "远端"), remoteWidth], [text(this.state.language, "TARGET", "目标"), 8], [text(this.state.language, "DOWN", "下载"), 10, "right"], [text(this.state.language, "UP", "上传"), 10, "right"]]),
        tableRule(tableWidth),
        ...visibleFlows.map((flow, index) => {
          const selected = start + index === this.state.selected
           const target = this.store.regionForHost(flow.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(flow.path) ? text(this.state.language, "hidden", "隐藏") : "-")
          const interfaceName = flow.interfaceName || "-"
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(flow.process, 18)}`, 20, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(pathLabel(flow.path, this.state.language), 8, pathColor(flow.path), { bold: true }),
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
      ? this.store.regionForHost(selected.remote.host) || (["LOCAL_PROXY", "TUNNELED"].includes(selected.path) ? text(this.state.language, "hidden by proxy/VPN", "被代理/VPN 隐藏") : text(this.state.language, "unknown", "未知"))
      : text(this.state.language, "unknown", "未知")
    this.detailText.content = selected
      ? styledLines([
          labeledLine(text(this.state.language, "Process", "进程"), [styled(selected.process, COLOR.bright, { bold: true }), styled(`  PID=${selected.pid}`, COLOR.muted)]),
          labeledLine(text(this.state.language, "Endpoints", "端点"), `${selected.local.raw}  →  ${selected.remote.raw}`, COLOR.indigo),
          labeledLine(text(this.state.language, "Classification", "分类"), [
            styled(`${pathLabel(selected.path, this.state.language)}  |  ${text(this.state.language, "confidence", "置信度")}=${selected.confidence}  |  ${text(this.state.language, "interface", "接口")}=${selected.interfaceName || text(this.state.language, "unknown", "未知")}`, pathColor(selected.path)),
            styled(text(this.state.language, "  |  country=", "  |  国家="), COLOR.muted),
            styled(selectedTarget, targetColor(selectedTarget)),
          ]),
          labeledLine(text(this.state.language, "Metrics", "指标"), `${text(this.state.language, "state", "状态")}=${selected.state || "-"}  RTT=${selected.rttMs?.toFixed(1) || "-"}ms  ↓ ${formatRate(selected.rateIn)}  ↑ ${formatRate(selected.rateOut)}`, COLOR.cyan),
          ...selected.evidence.slice(0, 3).map((evidence, index) => labeledLine(index === 0 ? text(this.state.language, "Evidence", "证据") : "", evidence, COLOR.amber)),
          labeledLine(text(this.state.language, "Keys", "快捷键"), text(this.state.language, `/ search  j/k select  s sort(${this.state.sort})  p pause  q quit`, `/ 搜索  j/k 选择  s 排序(${this.state.sort})  p 暂停  q 退出`), COLOR.muted),
        ])
      : styledLines([labeledLine(text(this.state.language, "Flow", "连接"), text(this.state.language, "No matching flow.", "没有匹配的连接。"), COLOR.muted)])
  }

  private renderDiagnostics(snapshot: NetworkSnapshot, apps: AppSummary[]): void {
    if (!this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = this.state.language === "zh"
      ? " 4 诊断：配置、DNS 和不确定性 "
      : " 4 Diagnostics: configuration, DNS, and uncertainty "
    const direct = apps.filter((app) => app.verdict === "DIRECT").map((app) => app.process)
    const mixed = apps.filter((app) => app.verdict === "MIXED").map((app) => app.process)
    const unknown = apps.filter((app) => app.verdict === "UNKNOWN").map((app) => app.process)
    const controller = this.store.getControllerSnapshot()
    this.contentText.content = styledLines([
       labeledLine(text(this.state.language, "System proxy", "系统代理"), proxyText(snapshot), proxyText(snapshot) === "disabled" ? COLOR.muted : COLOR.green),
       labeledLine(text(this.state.language, "Proxy exclusions", "代理例外"), snapshot.proxy.exceptions.join(", ") || text(this.state.language, "none", "无"), COLOR.muted),
       labeledLine(text(this.state.language, "Connected VPNs", "已连接 VPN"), snapshot.vpnServices.filter((item) => item.state === "Connected").map((item) => `${item.name}/${item.interfaceName}`).join(", ") || text(this.state.language, "none", "无"), COLOR.purple),
       labeledLine(text(this.state.language, "Unknown tunnels", "未知隧道"), snapshot.interfaces.filter((item) => item.kind === "tunnel" && !item.owner).map((item) => item.name).join(", ") || text(this.state.language, "none", "无"), COLOR.amber),
       labeledLine("ZeroTier", snapshot.overlayNetworks.map((item) => `${item.name}[${item.id}]/${item.interfaceName}/${item.status}`).join(", ") || text(this.state.language, "none", "无"), COLOR.indigo),
       labeledLine(text(this.state.language, "DNS resolvers", "DNS 解析器"), snapshot.dnsResolvers.map((item) => `${item.servers.join("+")}@${item.interfaceName || text(this.state.language, "global", "全局")}${item.scoped ? text(this.state.language, " scoped", " 作用域") : ""}`).join(" | ") || text(this.state.language, "unknown", "未知"), COLOR.cyan),
       labeledLine(text(this.state.language, "DIRECT apps", "直连应用"), direct.join(", ") || text(this.state.language, "none observed", "未观测到"), direct.length ? COLOR.red : COLOR.muted),
       labeledLine(text(this.state.language, "MIXED apps", "混合应用"), mixed.join(", ") || text(this.state.language, "none observed", "未观测到"), mixed.length ? COLOR.amber : COLOR.muted),
       labeledLine(text(this.state.language, "UNKNOWN apps", "未知应用"), unknown.join(", ") || text(this.state.language, "none observed", "未观测到"), COLOR.muted),
       labeledLine(text(this.state.language, "Collector errors", "采集器错误"), snapshot.errors.join(" | ") || text(this.state.language, "none", "无"), snapshot.errors.length ? COLOR.red : COLOR.green),
       labeledLine(text(this.state.language, "Geo database", "地理数据库"), this.geoStatus, geoColor(this.geoStatus)),
       labeledLine(text(this.state.language, "Clash controller", "Clash 控制器"), controller ? `${controller.url} (${controller.connections.length} ${text(this.state.language, "connections", "个连接")})` : text(this.state.language, "not connected", "未连接"), controller ? COLOR.green : COLOR.muted),
       labeledLine(text(this.state.language, "Privileged pktap", "特权 pktap"), `${this.state.pktap}  |  ${text(this.state.language, "packets", "数据包")}=${this.state.packetCount}  |  ${text(this.state.language, "last", "最后")}=${this.state.lastPacket}`, this.state.packetCount ? COLOR.purple : COLOR.muted),
    ])
    this.detailText.content = styledLines([
       labeledLine("PROXIED", text(this.state.language, "Observed local proxy hop or an attributed active VPN interface.", "观测到本地代理跳转或已归属的活动 VPN 接口。"), COLOR.green),
       labeledLine("DIRECT", text(this.state.language, "Physical-interface connection with no observed local proxy hop.", "通过物理接口连接，未观测到本地代理跳转。"), COLOR.red),
       labeledLine("MIXED", text(this.state.language, "The same application has both proxied and direct flows; inspect it.", "同一应用同时存在代理和直连流量；请进一步检查。"), COLOR.amber),
       labeledLine(text(this.state.language, "Local proxies", "本地代理"), text(this.state.language, "Targets and selected nodes stay hidden unless a compatible controller provides the join.", "除非兼容的控制器提供关联信息，否则目标和节点会保持隐藏。"), COLOR.indigo),
       labeledLine("Shadowrocket", text(this.state.language, "No equivalent stable public Controller API is available for exact rule/node chains.", "没有等价且稳定的公开控制器 API 可提供精确规则/节点链。"), COLOR.purple),
       labeledLine(text(this.state.language, "Geo data", "地理数据"), text(this.state.language, "Country labels indicate IP allocation and may not equal physical location.", "国家标签表示 IP 分配地，不一定是实际物理位置。"), COLOR.cyan),
       labeledLine(text(this.state.language, "Keys", "快捷键"), text(this.state.language, "1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  q quit", "1 应用  2 拓扑  3 连接  4 诊断  5 设置  q 退出"), COLOR.muted),
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
