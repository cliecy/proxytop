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
import { discoverProxyEngines, knownProxyProcess } from "./classifier"
import { saveConfig, type Language } from "./config"
import { fit, formatRate, pathLabel, sparkline } from "./format"
import { FlowStore } from "./store"
import { isAllowedDashboardInputSequence, MOUSE_TRACKING_OFF } from "./terminal-input"

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
    BYPASSED: COLOR.orange,
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
  advanced: boolean
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
    BYPASSED: ["BYPASS", "绕过"],
    MIXED: ["MIXED!", "混合"],
    OVERLAY: ["OVERLAY", "覆盖"],
    ENGINE: ["ENGINE", "引擎"],
    LOCAL: ["LOCAL", "本地"],
    UNKNOWN: ["UNKNOWN", "未知"],
  }
  return labels[app.verdict][language === "zh" ? 1 : 0]
}

function appVia(app: AppSummary): string {
  if (app.mechanism) return app.mechanism
  if (app.proxyHops.length) return app.proxyHops.join(", ")
  if (app.tunnelOwners.length) return app.tunnelOwners.join(", ")
  if (app.interfaces.length) return app.interfaces.join(", ")
  return "—"
}

function engineSummaryLine(
  engines: ReturnType<FlowStore["engines"]>,
  language: Language,
): string {
  if (engines.length === 0) return text(language, "none detected", "未检测到")
  return engines
    .map((engine) => {
      const bits = [
        engine.ports[0],
        engine.vpnInterfaces[0] ? `VPN ${engine.vpnInterfaces[0]}` : undefined,
        engine.roles.includes("system-proxy") ? "system-proxy" : undefined,
        engine.roles.length === 1 && engine.roles[0] === "listen+outbound"
          ? text(language, "possible", "可能")
          : undefined,
      ].filter(Boolean)
      return bits.length ? `${engine.process} (${bits.join(", ")})` : engine.process
    })
    .join(" · ")
}

function appProtocol(app: AppSummary): string {
  const protocols = [...app.proxyProtocols, ...app.transports]
  return [...new Set(protocols)].join(", ") || "—"
}

function appExit(app: AppSummary, language: Language): string {
  const proxiedLike =
    app.verdict === "PROXIED" ||
    app.verdict === "ENGINE" ||
    app.paths.includes("TUNNELED") ||
    (app.verdict !== "BYPASSED" && app.proxyHops.length > 0)
  // Prefer VPN/proxy node country over target country for proxied paths.
  if (proxiedLike) {
    if (app.nodeRegions.length) {
      return text(language, `node ${app.nodeRegions.join(",")}`, `节点 ${app.nodeRegions.join(",")}`)
    }
    return text(language, "hidden", "隐藏")
  }
  if (app.regions.length) return app.regions.join(",")
  return "—"
}

function coverageSummary(apps: AppSummary[], language: Language): string {
  const proxied = apps.filter((app) => app.verdict === "PROXIED").length
  const direct = apps.filter((app) => app.verdict === "DIRECT").length
  const bypassed = apps.filter((app) => app.verdict === "BYPASSED").length
  const mixed = apps.filter((app) => app.verdict === "MIXED").length
  return text(
    language,
    `${proxied} proxied · ${direct} direct · ${bypassed} bypassed · ${mixed} mixed`,
    `${proxied} 代理 · ${direct} 直连 · ${bypassed} 绕过 · ${mixed} 混合`,
  )
}

function sortApps(apps: AppSummary[], sort: UiState["sort"]): AppSummary[] {
  const verdictPriority: Record<AppSummary["verdict"], number> = {
    MIXED: 0,
    DIRECT: 1,
    BYPASSED: 2,
    UNKNOWN: 3,
    PROXIED: 4,
    OVERLAY: 5,
    ENGINE: 6,
    LOCAL: 7,
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
  private statusBox?: BoxRenderable
  private detailBox?: BoxRenderable
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
    advanced: false,
    settingsStatus: "loaded",
  }

  constructor(
    private readonly store: FlowStore,
    private readonly geoStatus: string,
    initialLanguage: Language = "en",
    initialAdvanced = false,
  ) {
    this.state.language = initialLanguage
    this.state.advanced = initialAdvanced
  }

  private persistConfig(): void {
    this.state.settingsStatus = "saving"
    void saveConfig({ language: this.state.language, advancedMode: this.state.advanced })
      .then(() => {
        this.state.settingsStatus = "saved"
        this.render()
      })
      .catch((error) => {
        this.state.settingsStatus = `save failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 48)
        this.render()
      })
  }

  private toggleAdvanced(): void {
    this.state.advanced = !this.state.advanced
    if (!this.state.advanced && !["apps", "settings"].includes(this.state.view)) {
      this.state.view = "apps"
      this.state.selected = 0
    }
    this.persistConfig()
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
    process.stdout.write(MOUSE_TRACKING_OFF)
    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      screenMode: "alternate-screen",
      consoleMode: "disabled",
      enableMouseMovement: false,
      useMouse: false,
      targetFps: 30,
      backgroundColor: COLOR.background,
    })
    const renderer = this.renderer
    const consumeUnexpectedInput = (sequence: string): boolean =>
      !isAllowedDashboardInputSequence(sequence, this.state.searching)
    renderer.addInputHandler(consumeUnexpectedInput)
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
      renderer.removeInputHandler(consumeUnexpectedInput)
      if (!renderer.isDestroyed) renderer.destroy()
      process.stdout.write(MOUSE_TRACKING_OFF)
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
      height: 6,
      border: true,
      borderStyle: "rounded",
      borderColor: "#2dd4bf",
      title: " proxytop ",
      titleColor: "#5eead4",
      backgroundColor: COLOR.panel,
      paddingX: 1,
    })
    this.statusBox = statusBox
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
      height: 7,
      border: true,
      borderStyle: "rounded",
      borderColor: "#f59e0b",
      title: " detail ",
      titleColor: "#fbbf24",
      backgroundColor: COLOR.detailPanel,
      paddingX: 1,
    })
    this.detailBox = detailBox
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
    if (key.name === "2") this.switchView(this.state.advanced ? "topology" : "settings")
    if (key.name === "3" && this.state.advanced) this.switchView("flows")
    if (key.name === "4" && this.state.advanced) this.switchView("diagnostics")
    if (key.name === "5") this.switchView("settings")
    if (key.name === "a") this.toggleAdvanced()
    if (key.name === "l") {
      this.state.language = this.state.language === "en" ? "zh" : "en"
      this.persistConfig()
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
    const allApps = this.store.apps()
    const chartWidth = Math.max(8, Math.min(28, this.renderer.width - 88))
    const advanced = this.state.advanced
    const vpnSummary = snapshot.vpnServices
      .filter((service) => service.state === "Connected")
      .map((service) => `${service.name}/${service.interfaceName || "?"}${service.primary ? "*" : ""}`)
      .join(", ") || text(this.state.language, "none", "无")
    const otherTunnels = snapshot.interfaces.filter((item) => item.kind === "tunnel")
    const attributedTunnels = otherTunnels.filter((item) => item.owner).length
    const zeroTier = snapshot.overlayNetworks.map((item) => `${item.name}/${item.interfaceName}`)
    if (this.state.view === "apps") {
      this.state.selected = Math.min(this.state.selected, Math.max(0, apps.length - 1))
    }
    if (this.statusBox) {
      this.statusBox.height = advanced ? 9 : 6
      this.statusBox.title = advanced
        ? " proxytop / application proxy locator "
        : text(this.state.language, " proxytop / who is proxied? ", " proxytop / 谁在走代理？ ")
    }
    if (this.detailBox) {
      this.detailBox.height = advanced ? 10 : 7
      this.detailBox.title = advanced
        ? " explanation / evidence "
        : text(this.state.language, " summary ", " 摘要 ")
    }

    const packetStatus = this.state.packetCount > 0
      ? `${this.state.pktap}(${this.state.packetCount},${this.state.lastPacket})`
      : this.state.pktap
    const statusWidth = Math.max(20, this.renderer.width - 4)
    const statusValueWidth = Math.max(1, statusWidth - 21)
    const liveLabel = this.state.paused
      ? text(this.state.language, "PAUSED", "暂停")
      : text(this.state.language, "LIVE", "实时")
    const modeLabel = advanced
      ? text(this.state.language, "ADVANCED", "高级")
      : text(this.state.language, "SIMPLE", "简洁")
    const engines = this.store.engines()
    const coverage = coverageSummary(allApps, this.state.language)
    const directNames = allApps.filter((app) => app.verdict === "DIRECT").map((app) => app.process)
    const bypassedNames = allApps.filter((app) => app.verdict === "BYPASSED").map((app) => app.process)
    const mixedNames = allApps.filter((app) => app.verdict === "MIXED").map((app) => app.process)
    const directAttention = [...mixedNames, ...directNames].slice(0, 8).join(", ") || text(this.state.language, "none", "无")
    const bypassAttention = bypassedNames.slice(0, 8).join(", ") || text(this.state.language, "none", "无")
    const coverageColor = directNames.length > 0 || mixedNames.length > 0 ? COLOR.red : bypassedNames.length > 0 ? COLOR.orange : COLOR.green
    const engineLine = engineSummaryLine(engines, this.state.language)

    const statusLines: TextChunk[][] = [
      labeledLine(
        text(this.state.language, "Engines", "代理引擎"),
        fit(`${engines.length}: ${engineLine}`, statusValueWidth).trimEnd(),
        engines.length ? COLOR.green : COLOR.muted,
      ),
      labeledLine(
        text(this.state.language, "System proxy", "系统代理"),
        fit(proxyText(snapshot), statusValueWidth).trimEnd(),
        proxyText(snapshot) === "disabled" ? COLOR.muted : COLOR.green,
      ),
      labeledLine(
        text(this.state.language, "VPN", "VPN"),
        fit(advanced
          ? `${vpnSummary}  |  ${text(this.state.language, "other utun", "其他 utun")}=${otherTunnels.length} (${attributedTunnels} ${text(this.state.language, "named", "已命名")})  |  ZeroTier=${zeroTier.length}`
          : vpnSummary, statusValueWidth).trimEnd(),
        vpnSummary === text(this.state.language, "none", "无") ? COLOR.muted : COLOR.purple,
      ),
      labeledLine(text(this.state.language, "Coverage", "覆盖"), fit(coverage, statusValueWidth).trimEnd(), coverageColor),
      labeledLine(
        text(this.state.language, "Not proxied", "未走代理"),
        fit(directAttention, statusValueWidth).trimEnd(),
        directNames.length || mixedNames.length ? COLOR.red : COLOR.muted,
      ),
      labeledLine(
        text(this.state.language, "Controller bypass", "控制器绕过"),
        fit(bypassAttention, statusValueWidth).trimEnd(),
        bypassedNames.length ? COLOR.orange : COLOR.muted,
      ),
      labeledLine(text(this.state.language, "WAN", "WAN"), [
        styled("↓ ", COLOR.cyan, { bold: true }),
        styled(formatRate(totals.rateIn), COLOR.cyan),
        styled(` ${sparkline(history.inbound, chartWidth)}  `, COLOR.muted, { dim: true }),
        styled("↑ ", COLOR.pink, { bold: true }),
        styled(formatRate(totals.rateOut), COLOR.pink),
        styled(` ${sparkline(history.outbound, chartWidth)}  `, COLOR.muted, { dim: true }),
        styled(liveLabel, this.state.paused ? COLOR.amber : COLOR.green, { bold: true }),
        styled(`  ${modeLabel}`, advanced ? COLOR.amber : COLOR.muted),
      ]),
    ]

    if (advanced) {
      const dnsInterfaces = [...new Set(snapshot.dnsResolvers.map((item) => item.interfaceName).filter(Boolean))].join(",") || "unknown"
      const focus = this.state.view === "apps" ? apps[this.state.selected] : undefined
      const focusText = this.state.view === "apps"
        ? focus
          ? `${focus.process}: ${verdictLabel(focus, this.state.language)} ${text(this.state.language, "via", "路径")} ${appVia(focus)} ${text(this.state.language, "exit", "出口")}=${appExit(focus, this.state.language)}`
          : text(this.state.language, "select an app", "请选择一个应用")
        : this.state.view === "topology"
          ? text(this.state.language, "complete local network topology", "完整的本地网络拓扑")
          : this.state.view === "flows"
            ? text(this.state.language, "raw connection evidence", "原始连接证据")
            : this.state.view === "diagnostics"
              ? text(this.state.language, "configuration and uncertainty", "配置与不确定性")
              : text(this.state.language, "settings and terminology guide", "设置与术语说明")
      const collectorChunks = this.renderer.width < 120
        ? [
            styled(text(this.state.language, "net=", "网络="), COLOR.muted), cell(this.state.nettop, 7, COLOR.cyan, { bold: true }),
            styled(text(this.state.language, "  pkt=", "  抓包="), COLOR.muted), cell(packetStatus, 4, COLOR.purple),
            styled("  clash=", COLOR.muted), cell(this.state.clash, 6, COLOR.amber),
            styled(text(this.state.language, "  geo=", "  地理="), COLOR.muted), cell(this.geoStatus, 4, geoColor(this.geoStatus)),
          ]
        : [
            styled("nettop=", COLOR.muted), styled(this.state.nettop, COLOR.cyan, { bold: true }),
            styled(text(this.state.language, "  pktap=", "  抓包="), COLOR.muted), styled(packetStatus, COLOR.purple),
            styled("  clash=", COLOR.muted), styled(this.state.clash, COLOR.amber),
            styled(text(this.state.language, "  geo=", "  地理="), COLOR.muted), styled(this.geoStatus, geoColor(this.geoStatus)),
          ]
      statusLines.push(
        labeledLine(text(this.state.language, "Default path", "默认路径"), fit(`${snapshot.defaultInterface || text(this.state.language, "unknown", "未知")}  |  DNS=${dnsInterfaces}`, statusValueWidth).trimEnd(), interfaceColor(snapshot.defaultInterface || "unresolved")),
        labeledLine(text(this.state.language, "Focus", "当前焦点"), fit(focusText, statusValueWidth).trimEnd(), focus ? verdictColor(focus.verdict) : COLOR.muted),
        labeledLine(text(this.state.language, "Collectors", "采集器"), collectorChunks),
      )
    }

    this.statusText.content = styledLines(statusLines)

    if (this.state.view === "apps") this.renderApps(apps)
    else if (this.state.view === "topology" && advanced) this.renderTopology(snapshot)
    else if (this.state.view === "flows" && advanced) this.renderFlows()
    else if (this.state.view === "diagnostics" && advanced) this.renderDiagnostics(snapshot, allApps)
    else if (this.state.view === "settings") this.renderSettings()
    else {
      this.state.view = "apps"
      this.renderApps(apps)
    }
  }

  private filteredApps(): AppSummary[] {
    const needle = this.state.filter.toLowerCase()
    let apps = this.store.apps().filter((app) => !needle || app.process.toLowerCase().includes(needle))
    if (!this.state.advanced) {
      // Keep DIRECT/MIXED always (leak attention); drop idle LAN/unknown noise.
      apps = apps.filter((app) => {
        if (app.verdict === "DIRECT" || app.verdict === "BYPASSED" || app.verdict === "MIXED" || app.verdict === "PROXIED") return true
        if (app.verdict === "ENGINE" || app.verdict === "OVERLAY") return true
        if (app.verdict === "LOCAL") return false
        if (app.verdict === "UNKNOWN" && app.rateIn + app.rateOut <= 0) return false
        return app.connections > 0
      })
    }
    return sortApps(apps, this.state.sort)
  }

  private renderApps(apps: AppSummary[]): void {
    if (!this.renderer || !this.contentBox || !this.contentText || !this.detailText) return
    const advanced = this.state.advanced
    this.contentBox.title = this.state.language === "zh"
      ? ` 应用：谁在走代理？ ${this.searchLabel()} `
      : ` Apps: who is proxied? ${this.searchLabel()} `
    this.state.selected = Math.min(this.state.selected, Math.max(0, apps.length - 1))
    const tableWidth = Math.max(20, this.renderer.width - 4)
    const chrome = advanced ? 22 : 16
    const rows = Math.max(1, this.renderer.height - chrome)
    const start = Math.max(0, Math.min(this.state.selected - rows + 1, Math.max(0, apps.length - rows)))
    const visibleApps = apps.slice(start, start + rows)

    if (!advanced) {
      const nameWidth = this.renderer.width < 95 ? 18 : 24
      const statusWidth = 8
      const exitWidth = 10
      const viaWidth = Math.max(8, tableWidth - nameWidth - statusWidth - exitWidth - 10 - 10 - 15)
      const lines = [
        tableHeader([
          [text(this.state.language, "APP", "应用"), nameWidth],
          [text(this.state.language, "STATUS", "状态"), statusWidth],
          [text(this.state.language, "CONTROL", "控制方式"), viaWidth],
          [text(this.state.language, "EXIT", "出口"), exitWidth],
          [text(this.state.language, "DOWN", "下载"), 10, "right"],
          [text(this.state.language, "UP", "上传"), 10, "right"],
        ]),
        tableRule(tableWidth),
        ...visibleApps.map((app, index) => {
          const selected = start + index === this.state.selected
          const exit = appExit(app, this.state.language)
          return paintRow([
            cell(`${selected ? "▸" : " "} ${fit(app.process, nameWidth - 2)}`, nameWidth, COLOR.bright, { bold: selected }),
            columnDivider(),
            cell(verdictLabel(app, this.state.language), statusWidth, verdictColor(app.verdict), { bold: true }),
            columnDivider(),
            cell(appVia(app), viaWidth, verdictColor(app.verdict)),
            columnDivider(),
            cell(exit, exitWidth, targetColor(exit)),
            columnDivider(),
            cell(formatRate(app.rateIn), 10, COLOR.cyan, { align: "right" }),
            columnDivider(),
            cell(formatRate(app.rateOut), 10, COLOR.pink, { align: "right" }),
          ], rowBackground(start + index, selected))
        }),
      ]
      this.contentText.content = styledLines(lines)
    } else if (this.renderer.width < 140) {
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
          const target = appExit(app, this.state.language)
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

  private keyHint(): string {
    if (!this.state.advanced) {
      return text(
        this.state.language,
        `a advanced  1 Apps  2 Settings  / search  j/k  s sort(${this.state.sort})  p pause  q quit`,
        `a 高级  1 应用  2 设置  / 搜索  j/k  s 排序(${this.state.sort})  p 暂停  q 退出`,
      )
    }
    return text(
      this.state.language,
      `a simple  1 Apps  2 Topology  3 Flows  4 Diagnostics  5 Settings  / search  j/k  s sort(${this.state.sort})  p pause  q quit`,
      `a 简洁  1 应用  2 拓扑  3 连接  4 诊断  5 设置  / 搜索  j/k  s 排序(${this.state.sort})  p 暂停  q 退出`,
    )
  }

  private appDetail(app: AppSummary): StyledText {
    const exit = appExit(app, this.state.language)
    if (!this.state.advanced) {
      return styledLines([
        labeledLine(text(this.state.language, "App", "应用"), [
          styled(app.process, COLOR.bright, { bold: true }),
          styled("  ", COLOR.muted),
          styled(verdictLabel(app, this.state.language), verdictColor(app.verdict), { bold: true }),
        ]),
        labeledLine(text(this.state.language, "Control", "控制"), app.mechanism || appVia(app), verdictColor(app.verdict)),
        labeledLine(text(this.state.language, "Exit", "出口"), exit, targetColor(exit)),
        labeledLine(
          text(this.state.language, "Hint", "提示"),
          app.verdict === "DIRECT" || app.verdict === "MIXED"
            ? text(this.state.language, "Not fully proxied — configure app/system/VPN proxy if needed.", "未完全走代理 — 如需代理请配置应用/系统/VPN。")
            : app.verdict === "BYPASSED"
              ? text(this.state.language, "The matched controller rule explicitly selected DIRECT.", "匹配的控制器规则明确选择了 DIRECT。")
            : app.verdict === "PROXIED"
              ? text(this.state.language, "Traffic is going through a local proxy or VPN.", "流量正经过本地代理或 VPN。")
              : text(this.state.language, "See advanced mode for full evidence.", "高级模式可看完整证据。"),
          app.verdict === "DIRECT" || app.verdict === "MIXED" ? COLOR.amber : app.verdict === "BYPASSED" ? COLOR.orange : COLOR.muted,
        ),
        labeledLine(text(this.state.language, "Keys", "快捷键"), this.keyHint(), COLOR.muted),
      ])
    }

    const hiddenDestination = app.verdict !== "BYPASSED" && app.proxyHops.length > 0 && app.destinations.length === 0
    const targetCountry = app.regions.join(", ") || (hiddenDestination || app.paths.includes("TUNNELED")
      ? text(this.state.language, "hidden behind proxy/VPN", "被代理/VPN 隐藏")
      : "—")
    const nodeCountry = app.nodeRegions.join(", ") || (app.verdict === "PROXIED" || app.paths.includes("TUNNELED") || app.verdict === "ENGINE"
      ? text(this.state.language, "not observed (need outer hop or VPN server IP)", "未观测到（需外层连接或 VPN 服务器 IP）")
      : "—")
    return styledLines([
      labeledLine(text(this.state.language, "Application", "应用程序"), [
        styled(app.process, COLOR.bright, { bold: true }),
        styled(`  PID=${app.pids.join(",")}  `, COLOR.muted),
        styled(verdictLabel(app, this.state.language), verdictColor(app.verdict), { bold: true }),
        styled(`  ${text(this.state.language, "confidence", "置信度")}=${app.confidence}`, COLOR.muted),
      ]),
      labeledLine(text(this.state.language, "Control", "控制"), app.mechanism, verdictColor(app.verdict)),
      labeledLine(text(this.state.language, "Observed path", "观测路径"), `${app.paths.map((path) => pathLabel(path, this.state.language)).join(" + ")}  |  ${text(this.state.language, "via", "路径")}=${app.proxyHops[0] || app.tunnelOwners[0] || app.interfaces.join(", ") || "—"}`, verdictColor(app.verdict)),
      labeledLine(text(this.state.language, "Proxy / transport", "代理 / 传输"), `${app.proxyProtocols.join(", ") || text(this.state.language, "none observed", "未观测到")}  |  ${app.transports.join(", ")}`, COLOR.indigo),
      labeledLine(text(this.state.language, "Controller / rule", "控制器 / 规则"), `${app.proxyChains.join(" | ") || text(this.state.language, "not available", "不可用")}  ${app.rules.join(" | ") || ""}`, app.proxyChains.length ? COLOR.green : COLOR.muted),
      labeledLine(text(this.state.language, "Interfaces", "网络接口"), `${app.interfaces.join(", ") || "—"}  |  tunnel=${app.tunnelOwners.join(", ") || "—"}`, interfaceColor(app.interfaces[0] || "—")),
      labeledLine(text(this.state.language, "Destinations", "目标"), hiddenDestination ? text(this.state.language, "hidden behind local proxy", "被本地代理隐藏") : app.destinations.join(", ") || text(this.state.language, "none", "无"), hiddenDestination ? COLOR.amber : COLOR.text),
      labeledLine(text(this.state.language, "Target country", "目标国家"), targetCountry, targetColor(targetCountry)),
      labeledLine(text(this.state.language, "Node country", "节点国家"), nodeCountry, app.nodeRegions.length ? COLOR.green : COLOR.muted),
      labeledLine(text(this.state.language, "Keys", "快捷键"), this.keyHint(), COLOR.muted),
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
    const discovered = new Set(discoverProxyEngines(snapshot).proxyProcesses)
    for (const listener of snapshot.listeners.filter(
      (item) => (knownProxyProcess(item.process) || discovered.has(item.process)) && !configuredPorts.has(item.port),
    )) {
      topologyRows.push(["PROXY PORT", listener.process, "listening", "TCP", `${listener.host}:${listener.port}`, "proxy listener"])
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
       labeledLine(text(this.state.language, "Keys", "快捷键"), this.keyHint(), COLOR.muted),
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
          labeledLine(text(this.state.language, "Keys", "快捷键"), this.keyHint(), COLOR.muted),
        ])
      : styledLines([labeledLine(text(this.state.language, "Flow", "连接"), text(this.state.language, "No matching flow.", "没有匹配的连接。"), COLOR.muted)])
  }

  private renderDiagnostics(snapshot: NetworkSnapshot, apps: AppSummary[]): void {
    if (!this.contentBox || !this.contentText || !this.detailText) return
    this.contentBox.title = this.state.language === "zh"
      ? " 4 诊断：配置、DNS 和不确定性 "
      : " 4 Diagnostics: configuration, DNS, and uncertainty "
    const direct = apps.filter((app) => app.verdict === "DIRECT").map((app) => app.process)
    const bypassed = apps.filter((app) => app.verdict === "BYPASSED").map((app) => app.process)
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
       labeledLine(text(this.state.language, "BYPASSED apps", "控制器绕过应用"), bypassed.join(", ") || text(this.state.language, "none observed", "未观测到"), bypassed.length ? COLOR.orange : COLOR.muted),
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
       labeledLine("BYPASSED", text(this.state.language, "A matched controller decision selected DIRECT.", "匹配的控制器决策选择了 DIRECT。"), COLOR.orange),
       labeledLine("MIXED", text(this.state.language, "The same application has multiple independent route types; inspect it.", "同一应用存在多种独立路线；请进一步检查。"), COLOR.amber),
       labeledLine(text(this.state.language, "Local proxies", "本地代理"), text(this.state.language, "Targets and selected nodes stay hidden unless a compatible controller provides the join.", "除非兼容的控制器提供关联信息，否则目标和节点会保持隐藏。"), COLOR.indigo),
       labeledLine("Shadowrocket", text(this.state.language, "No equivalent stable public Controller API is available for exact rule/node chains.", "没有等价且稳定的公开控制器 API 可提供精确规则/节点链。"), COLOR.purple),
       labeledLine(text(this.state.language, "Geo data", "地理数据"), text(this.state.language, "Country labels indicate IP allocation and may not equal physical location.", "国家标签表示 IP 分配地，不一定是实际物理位置。"), COLOR.cyan),
       labeledLine(text(this.state.language, "Keys", "快捷键"), this.keyHint(), COLOR.muted),
    ])
  }

  private renderSettings(): void {
    if (!this.contentBox || !this.contentText || !this.detailText) return
    const chinese = this.state.language === "zh"
    const advanced = this.state.advanced
    this.contentBox.title = chinese
      ? (advanced ? " 设置 / README：术语说明 " : " 设置 ")
      : (advanced ? " Settings / README: terminology guide " : " Settings ")
    const modeLine = advanced
      ? (chinese ? "高级模式  (按 a 切回简洁)" : "Advanced  (press a for simple)")
      : (chinese ? "简洁模式  (按 a 打开高级：拓扑/连接/诊断)" : "Simple  (press a for advanced: topology/flows/diagnostics)")
    const simpleRows = chinese
      ? [
          ["代理", "应用走了本地代理或已识别的 VPN/TUN。", COLOR.green],
          ["直连", "应用经物理网卡出去，未看到本地代理跳。", COLOR.red],
          ["绕过", "匹配的控制器规则选择了 DIRECT。", COLOR.orange],
          ["混合", "同一应用存在多种独立路线，值得留意。", COLOR.amber],
          ["经由", "本地代理进程、VPN 服务或网卡接口。", COLOR.cyan],
          ["出口", "目标 IP 分配国家；被代理藏住时显示「隐藏」。", COLOR.amber],
        ] as Array<[string, string, string]>
      : [
          ["Proxied", "App used a local proxy or attributed VPN/TUN path.", COLOR.green],
          ["Direct", "App used a physical interface with no local proxy hop.", COLOR.red],
          ["Bypassed", "A matched controller rule selected DIRECT.", COLOR.orange],
          ["Mixed", "The same app has multiple independent route types.", COLOR.amber],
          ["Via", "Local proxy process, VPN service, or interface.", COLOR.cyan],
          ["Exit", "Destination IP country; hidden when behind proxy/VPN.", COLOR.amber],
        ] as Array<[string, string, string]>
    const advancedRows = chinese
      ? [
          ["PROXIED", "观察到应用连接了本地代理，或使用了已识别的 VPN/TUN 路径。", COLOR.green],
          ["DIRECT", "应用通过物理网卡直连，未观察到本地代理跳转。", COLOR.red],
          ["BYPASSED", "匹配的控制器规则选择了 DIRECT。", COLOR.orange],
          ["MIXED", "同一个应用存在多种独立路线。", COLOR.amber],
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
          ["BYPASSED", "A matched controller rule selected DIRECT.", COLOR.orange],
          ["MIXED", "The same application has multiple independent route types.", COLOR.amber],
          ["OVERLAY", "Traffic uses an overlay interface such as ZeroTier.", COLOR.purple],
          ["ENGINE", "This is an outer connection from the proxy engine itself.", COLOR.cyan],
          ["UNKNOWN", "Evidence is insufficient; proxytop does not guess the route.", COLOR.muted],
          ["PROXY / TUN", "PROXY means a local proxy port; TUN means a VPN or tunnel interface.", COLOR.indigo],
          ["WAN observed", "Only physical-interface direct and proxy-engine traffic is counted to avoid duplicates.", COLOR.cyan],
          ["hidden", "A local proxy or TUN hides the final node; a compatible Clash/Mihomo API is needed.", COLOR.amber],
          ["confidence", "HIGH/MEDIUM/LOW describes evidence strength, not network speed.", COLOR.purple],
        ] as Array<[string, string, string]>
    const rows = advanced ? advancedRows : simpleRows
    this.contentText.content = styledLines([
      labeledLine(chinese ? "模式" : "Mode", `${modeLine}  (${this.state.settingsStatus})`, advanced ? COLOR.amber : COLOR.green),
      labeledLine(chinese ? "语言" : "Language", `${chinese ? "中文" : "English"}  (${chinese ? "按 l 切换到 English" : "press l to switch to Chinese"})`, COLOR.green),
      labeledLine(chinese ? "说明" : "Guide", chinese ? "默认只回答：谁在代理、经由谁、出口在哪。" : "Default view answers: who is proxied, via what, and exit country.", COLOR.text),
      ...rows.map(([term, explanation, color]) => labeledLine(term, explanation, color)),
    ])
    this.detailText.content = styledLines([
      labeledLine(chinese ? "视图" : "Views", this.keyHint(), COLOR.muted),
      labeledLine(chinese ? "操作" : "Controls", chinese ? "a 切换模式  l 语言  j/k 移动  / 搜索  s 排序  p 暂停  q 退出" : "a mode  l language  j/k move  / search  s sort  p pause  q quit", COLOR.muted),
      labeledLine(chinese ? "重要提示" : "Important", chinese ? "直连不自动等于泄漏；未知表示证据不足。" : "Direct does not automatically mean a leak; unknown means incomplete evidence.", COLOR.amber),
    ])
  }

  private searchLabel(): string {
    if (this.state.searching) return `[search: ${this.state.filter}_]`
    return this.state.filter ? `[filter: ${this.state.filter}]` : ""
  }
}
