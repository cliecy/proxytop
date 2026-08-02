import { runCommand } from "./commands"
import { NettopCollector } from "./collectors/nettop"
import { ClashCollector, controllerOwnerForUrl, discoverClashController } from "./collectors/clash"
import { collectNetworkSnapshot } from "./collectors/system"
import { knownProxyProcess } from "./classifier"
import { formatRate, pathLabel } from "./format"
import { GeoResolver } from "./geo"
import { FlowStore } from "./store"

export function redactProxyCredentials(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***:***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+@/gi, "$1***@")
    .replace(/([?&](?:access_?token|token|key|secret|password)=)[^&\s]+/gi, "$1***")
}

function displayTarget(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return redactProxyCredentials(value)
  }
}

function proxySummary(proxy: Awaited<ReturnType<typeof collectNetworkSnapshot>>["proxy"]): string {
  const entries: string[] = []
  if (proxy.httpEnabled) entries.push(`HTTP ${proxy.httpHost}:${proxy.httpPort}`)
  if (proxy.httpsEnabled) entries.push(`HTTPS ${proxy.httpsHost}:${proxy.httpsPort}`)
  if (proxy.socksEnabled) entries.push(`SOCKS ${proxy.socksHost}:${proxy.socksPort}`)
  if (proxy.pacEnabled) entries.push("PAC")
  return entries.join(", ") || "disabled"
}

export async function runDoctor(): Promise<number> {
  const snapshot = await collectNetworkSnapshot()
  console.log("proxytop doctor")
  console.log(`System proxy: ${proxySummary(snapshot.proxy)}`)
  console.log(`Default route: ${snapshot.defaultInterface ?? "unknown"}`)
  console.log(`Tunnels: ${snapshot.tunnelInterfaces.join(", ") || "none"}`)
  console.log(`VPN interfaces: ${snapshot.vpnInterfaces.join(", ") || "none"}`)
  console.log(`Physical interfaces: ${snapshot.physicalInterfaces.join(", ") || "none"}`)
  console.log(`TCP listeners: ${snapshot.listeners.length}`)
  console.log("VPN services:")
  for (const service of snapshot.vpnServices) {
    console.log(
      `  ${service.name}: ${service.state}, interface=${service.interfaceName || "none"}, primary=${service.primary}, provider=${service.providerBundleId || service.bundleId || "unknown"}`,
    )
  }
  console.log("Relevant interfaces:")
  for (const item of snapshot.interfaces.filter((entry) => ["physical", "vpn", "tunnel", "zerotier"].includes(entry.kind))) {
    console.log(
      `  ${item.name}: ${item.kind}, owner=${item.owner || "unattributed"}, state=${item.status}, default=${item.isDefault}, dns=${item.carriesDns}, addresses=${item.addresses.join(",") || "none"}`,
    )
  }
  const proxyListeners = snapshot.listeners.filter((listener) => knownProxyProcess(listener.process))
  console.log(`Proxy-owned TCP listeners: ${proxyListeners.map((item) => `${item.process}@${item.host}:${item.port}`).join(", ") || "none"}`)
  console.log(`ZeroTier networks: ${snapshot.overlayNetworks.map((item) => `${item.name}[${item.id}]@${item.interfaceName} ${item.addresses.join("+")} ${item.status}`).join(", ") || "none"}`)
  console.log(
    `DNS resolvers: ${snapshot.dnsResolvers.map((item) => `${item.servers.join("+")}@${item.interfaceName || "global"}${item.scoped ? "(scoped)" : ""}`).join(", ") || "none"}`,
  )
  if (snapshot.errors.length) {
    console.log("Errors:")
    for (const error of snapshot.errors) console.log(`  ${error}`)
    return 1
  }
  return 0
}

export async function inspectApp(
  query: string,
  durationMs = 4_000,
  controllerUrl = Bun.env.PROXYTOP_CLASH_CONTROLLER,
  controllerSecret = Bun.env.PROXYTOP_CLASH_SECRET,
): Promise<number> {
  delete Bun.env.PROXYTOP_CLASH_SECRET
  const geo = new GeoResolver()
  await geo.initialize()
  const store = new FlowStore()
  store.setRegionLookup(geo.lookup)
  const snapshot = await collectNetworkSnapshot()
  store.setSnapshot(snapshot)
  let collectorStatus = "starting"
  const collector = new NettopCollector(
    (sample) => store.upsert(sample),
    (status) => {
      collectorStatus = status
    },
  )
  const clashUrl = discoverClashController(snapshot.listeners, controllerUrl, Boolean(controllerSecret))
  const clash = clashUrl
    ? new ClashCollector(
        clashUrl,
        controllerSecret,
        controllerSecret ? controllerOwnerForUrl(clashUrl, snapshot.listeners) : undefined,
        (controllerSnapshot) => store.setControllerSnapshot(controllerSnapshot),
        () => {},
      )
    : undefined
  collector.start()
  clash?.start()
  await Bun.sleep(durationMs)
  collector.stop()
  clash?.stop()
  await Bun.sleep(250)

  const matches = store.apps().filter((app) => app.process.toLowerCase().includes(query.toLowerCase()))
  if (matches.length === 0) {
    console.error(`No active network flow matched "${query}" after ${durationMs / 1_000}s (collector=${collectorStatus}).`)
    return 1
  }

  for (const app of matches) {
    const hidden = app.proxyHops.length > 0 || app.paths.includes("TUNNELED")
    console.log(`${app.process} [${app.verdict}] confidence=${app.confidence}`)
    console.log(`  PIDs: ${app.pids.join(", ")}`)
    console.log(`  Paths: ${app.paths.map((path) => pathLabel(path)).join(" + ")}`)
    console.log(`  Proxy endpoint: ${app.proxyHops.join(", ") || "none observed"}`)
    console.log(`  Proxy configuration: ${app.proxyProtocols.join(", ") || "none observed"}`)
    console.log(`  Controller chain/rule: ${app.proxyChains.join(" | ") || "not available"} ${app.rules.join(" | ")}`)
    console.log(`  VPN/tunnel: ${app.tunnelOwners.join(", ") || "none/unknown"}`)
    console.log(`  Interfaces: ${app.interfaces.join(", ") || "unknown"}`)
    console.log(`  Transport: ${app.transports.join(", ") || "unknown"}`)
    console.log(`  Destinations: ${app.destinations.join(", ") || (hidden ? "hidden by proxy/VPN" : "none observed")}`)
    console.log(`  Target/remote country: ${app.regions.join(", ") || (hidden ? "hidden by proxy/VPN" : "unknown")}`)
    console.log(`  Observed socket rate: down=${formatRate(app.rateIn)} up=${formatRate(app.rateOut)}`)
  }
  return 0
}

export async function checkGit(url?: string): Promise<number> {
  const config = await runCommand("/usr/bin/git", [
    "config",
    "--show-origin",
    "--get-regexp",
    "^(http|https)\\..*proxy$|^http\\.proxy$|^https\\.proxy$|^core\\.gitproxy$|^remote\\..*\\.proxy$",
  ])
  console.log("Git proxy configuration:")
  console.log(config.stdout.trim() ? redactProxyCredentials(config.stdout.trim()) : "  no explicit Git proxy")

  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    const value = Bun.env[name]
    if (value) console.log(`${name}=${redactProxyCredentials(value)}`)
  }

  if (!url) return 0
  console.log(`\nRunning read-only git ls-remote probe for ${displayTarget(url)}`)
  const probe = await runCommand("/usr/bin/git", ["ls-remote", "--heads", "--", url], 20_000)
  if (probe.exitCode === 0) {
    console.log(`Probe succeeded (${probe.stdout.trim().split(/\r?\n/).filter(Boolean).length} refs)`)
    return 0
  }
  console.error(redactProxyCredentials(probe.stderr.trim() || `probe exited ${probe.exitCode}`))
  return probe.exitCode || 1
}

export async function checkSsh(host: string): Promise<number> {
  const result = await runCommand("/usr/bin/ssh", ["-G", "--", host], 10_000)
  if (result.exitCode !== 0) {
    console.error(result.stderr.trim())
    return result.exitCode || 1
  }
  const wanted = new Set([
    "host",
    "hostname",
    "user",
    "port",
    "proxycommand",
    "proxyjump",
    "addressfamily",
    "canonicalizehostname",
  ])
  console.log(`Effective SSH configuration for ${host}:`)
  for (const line of result.stdout.split(/\r?\n/)) {
    const key = line.split(/\s+/, 1)[0]?.toLowerCase()
    if (key === "proxycommand") console.log("proxycommand <configured; arguments redacted>")
    else if (key && wanted.has(key)) console.log(redactProxyCredentials(line))
  }
  console.log("Note: HTTP_PROXY does not make OpenSSH use an HTTP proxy; ProxyCommand, ProxyJump, or TUN routing can.")
  return 0
}

export async function checkUrl(url: string): Promise<number> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    console.error("URL must be an absolute HTTP or HTTPS URL.")
    return 2
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    console.error("Only HTTP/HTTPS URLs without embedded credentials are accepted.")
    return 2
  }
  const snapshot = await collectNetworkSnapshot()
  const args = ["-sS", "-o", "/dev/null", "-I", "--max-time", "15", "-w", "HTTP %{http_code} remote=%{remote_ip} time=%{time_total}s\\n"]
  const displayUrl = `${target.origin}${target.pathname}`
  console.log(`Proxy-free application probe (still subject to TUN routing): ${displayUrl}`)
  const direct = await runCommand("/usr/bin/curl", [...args, "--noproxy", "*", "--", target.toString()], 20_000)
  process.stdout.write(direct.stdout)
  if (direct.stderr) process.stderr.write(redactProxyCredentials(direct.stderr.replaceAll(target.toString(), displayUrl)))

  const protocol = target.protocol
  const proxy = snapshot.proxy
  const httpEndpoint =
    protocol === "https:" && proxy.httpsEnabled && proxy.httpsHost && proxy.httpsPort
      ? `http://${proxy.httpsHost}:${proxy.httpsPort}`
      : proxy.httpEnabled && proxy.httpHost && proxy.httpPort
        ? `http://${proxy.httpHost}:${proxy.httpPort}`
        : proxy.httpsEnabled && proxy.httpsHost && proxy.httpsPort
          ? `http://${proxy.httpsHost}:${proxy.httpsPort}`
          : undefined
  const proxyEndpoint =
    httpEndpoint ||
    (proxy.socksEnabled && proxy.socksHost && proxy.socksPort
      ? `socks5h://${proxy.socksHost}:${proxy.socksPort}`
      : undefined)
  if (proxyEndpoint) {
    console.log(`Explicit proxy probe: ${proxyEndpoint}`)
    const proxied = await runCommand("/usr/bin/curl", [...args, "--proxy", proxyEndpoint, "--", target.toString()], 20_000)
    process.stdout.write(proxied.stdout)
    if (proxied.stderr) process.stderr.write(redactProxyCredentials(proxied.stderr.replaceAll(target.toString(), displayUrl)))
    return direct.exitCode || proxied.exitCode
  }
  console.log("No enabled HTTP, HTTPS, or SOCKS proxy was found for an explicit comparison.")
  return direct.exitCode
}

export async function checkDns(host: string): Promise<number> {
  const result = await runCommand("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", host], 10_000)
  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.exitCode
}
