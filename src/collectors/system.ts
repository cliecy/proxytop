import { runCommand, type CommandResult } from "../commands"
import type { NetworkSnapshot } from "../domain"
import { buildInterfaceInventory, enrichVpnService, parseDefaultInterface, parseDnsResolvers, parseHardwareInterfaces, parseIfconfig, parseLsofListeners, parseNwiInterfaces, parseScutilProxy, parseVpnServiceList, parseZeroTierInterfaces, parseZeroTierNetworks } from "../parsers/system"

export interface SystemCollectorDependencies {
  runCommand?: typeof runCommand
  which?: (command: string) => string | null
  now?: () => number
}

type SnapshotSource = "proxy" | "defaultInterface" | "listeners" | "vpnServices" | "dnsResolvers" | "overlayNetworks" | "inventory"
export type SnapshotSourceFailures = Partial<Record<SnapshotSource, boolean>>

export function mergeNetworkSnapshot(current: NetworkSnapshot, previous: NetworkSnapshot | undefined, failures: SnapshotSourceFailures): NetworkSnapshot {
  if (!previous) return current
  return {
    ...current,
    proxy: failures.proxy ? previous.proxy : current.proxy,
    defaultInterface: failures.defaultInterface ? previous.defaultInterface : current.defaultInterface,
    listeners: failures.listeners ? previous.listeners : current.listeners,
    vpnServices: failures.vpnServices ? previous.vpnServices : current.vpnServices,
    dnsResolvers: failures.dnsResolvers ? previous.dnsResolvers : current.dnsResolvers,
    overlayNetworks: failures.overlayNetworks ? previous.overlayNetworks : current.overlayNetworks,
    interfaces: failures.inventory ? previous.interfaces : current.interfaces,
    physicalInterfaces: failures.inventory ? previous.physicalInterfaces : current.physicalInterfaces,
    tunnelInterfaces: failures.inventory ? previous.tunnelInterfaces : current.tunnelInterfaces,
    vpnInterfaces: failures.inventory ? previous.vpnInterfaces : current.vpnInterfaces,
  }
}

export async function collectNetworkSnapshot(signal?: AbortSignal, previous?: NetworkSnapshot, dependencies: SystemCollectorDependencies = {}): Promise<NetworkSnapshot> {
  const command = dependencies.runCommand ?? runCommand
  const which = dependencies.which ?? Bun.which
  const now = dependencies.now ?? Date.now
  const execute = async (path: string, args: string[]): Promise<CommandResult> => {
    try { return await command(path, args, 5_000, signal) }
    catch (error) { return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: -1 } }
  }
  const zeroTierCli = which("zerotier-cli")
  const [proxyResult, routeResult, nwiResult, listenersResult, vpnListResult, ifconfigResult, hardwareResult, dnsResult, zeroTierResult, zeroTierNetworksResult] = await Promise.all([
    execute("/usr/sbin/scutil", ["--proxy"]), execute("/sbin/route", ["-n", "get", "default"]),
    execute("/usr/sbin/scutil", ["--nwi"]), execute("/usr/sbin/lsof", ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN"]),
    execute("/usr/sbin/scutil", ["--nc", "list"]), execute("/sbin/ifconfig", ["-v", "-a"]),
    execute("/usr/sbin/networksetup", ["-listallhardwareports"]), execute("/usr/sbin/scutil", ["--dns"]),
    execute("/usr/bin/pgrep", ["-afil", "ZeroTier|zerotier|MacEthernetTapAgent"]),
    zeroTierCli ? execute(zeroTierCli, ["listnetworks", "-j"]) : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  ])

  const errors: string[] = []
  const failures: SnapshotSourceFailures = {}
  const record = (name: string, result: CommandResult, detail?: string) => {
    if (errors.length >= 32) return
    const reason = detail ?? (result.stderr.trim() || "exit " + result.exitCode)
    errors.push((name + ": " + reason).slice(0, 512))
  }
  const check = (name: string, result: CommandResult, source: SnapshotSource) => {
    if (result.exitCode === 0) return false
    record(name, result); failures[source] = true; return true
  }
  check("scutil --proxy", proxyResult, "proxy")
  check("route", routeResult, "defaultInterface")
  check("scutil --nwi", nwiResult, "inventory")
  check("lsof", listenersResult, "listeners")
  const vpnListFailed = check("scutil --nc list", vpnListResult, "vpnServices")
  check("ifconfig", ifconfigResult, "inventory")
  check("networksetup", hardwareResult, "inventory")
  check("scutil --dns", dnsResult, "dnsResolvers")
  if (dnsResult.exitCode !== 0 || routeResult.exitCode !== 0) failures.inventory = true
  if (zeroTierResult.exitCode !== 0 && zeroTierResult.exitCode !== 1) { record("pgrep ZeroTier", zeroTierResult); failures.inventory = true }

  const nwiInterfaces = parseNwiInterfaces(nwiResult.stdout)
  const defaultInterface = parseDefaultInterface(routeResult.stdout)
  let vpnEnrichmentFailed = false
  const vpnServices = vpnListFailed ? [] : await Promise.all(parseVpnServiceList(vpnListResult.stdout).map(async (service) => {
    const [show, status] = await Promise.all([execute("/usr/sbin/scutil", ["--nc", "show", service.id]), execute("/usr/sbin/scutil", ["--nc", "status", service.id])])
    if (show.exitCode !== 0) { record("scutil --nc show " + service.name, show); vpnEnrichmentFailed = true }
    if (status.exitCode !== 0) { record("scutil --nc status " + service.name, status); vpnEnrichmentFailed = true }
    return enrichVpnService(service, show.stdout, status.stdout)
  }))
  if (vpnListFailed || vpnEnrichmentFailed) { failures.vpnServices = true; failures.inventory = true }

  const dnsResolvers = parseDnsResolvers(dnsResult.stdout)
  const zeroTierOutput = zeroTierNetworksResult.stdout.trim()
  let zeroTierOutputIsArray = !zeroTierOutput
  if (zeroTierOutput) {
    try {
      const parsed = JSON.parse(zeroTierOutput) as unknown
      zeroTierOutputIsArray = Array.isArray(parsed) && parsed.every((value) => value !== null && typeof value === "object")
    } catch { zeroTierOutputIsArray = false }
  }
  const overlayNetworks = parseZeroTierNetworks(zeroTierNetworksResult.stdout)
  if (zeroTierCli && zeroTierNetworksResult.exitCode !== 0) {
    record("zerotier-cli listnetworks", zeroTierNetworksResult); failures.overlayNetworks = true; failures.inventory = true
  } else if (!zeroTierOutputIsArray) {
    record("zerotier-cli listnetworks", zeroTierNetworksResult, "output could not be parsed"); failures.overlayNetworks = true; failures.inventory = true
  }
  const zeroTierInterfaces = parseZeroTierInterfaces(zeroTierResult.exitCode === 1 ? "" : zeroTierResult.stdout)
  for (const network of overlayNetworks) zeroTierInterfaces.add(network.interfaceName)
  const inventory = buildInterfaceInventory(parseIfconfig(ifconfigResult.stdout), parseHardwareInterfaces(hardwareResult.stdout), vpnServices, zeroTierInterfaces, defaultInterface, new Set(dnsResolvers.map((resolver) => resolver.interfaceName).filter((name): name is string => Boolean(name))), new Map(overlayNetworks.map((network) => [network.interfaceName, "ZeroTier:" + network.name])))
  const physical = inventory.filter((item) => item.kind === "physical" && item.status === "active").map((item) => item.name)
  const current: NetworkSnapshot = {
    collectedAt: now(), proxy: parseScutilProxy(proxyResult.stdout), defaultInterface,
    physicalInterfaces: physical.length ? physical : nwiInterfaces.all.filter((name) => !name.startsWith("utun") && !name.startsWith("feth") && name !== "lo0"),
    tunnelInterfaces: inventory.filter((item) => item.kind === "vpn" || item.kind === "tunnel").map((item) => item.name),
    vpnInterfaces: [...new Set([...nwiInterfaces.vpn, ...vpnServices.map((service) => service.interfaceName).filter((name): name is string => Boolean(name))])],
    listeners: parseLsofListeners(listenersResult.stdout), vpnServices, interfaces: inventory, dnsResolvers, overlayNetworks, errors,
  }
  return mergeNetworkSnapshot(current, previous, failures)
}
