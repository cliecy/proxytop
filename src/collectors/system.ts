import { runCommand } from "../commands"
import type { NetworkSnapshot } from "../domain"
import {
  buildInterfaceInventory,
  enrichVpnService,
  parseDefaultInterface,
  parseDnsResolvers,
  parseHardwareInterfaces,
  parseIfconfig,
  parseLsofListeners,
  parseNwiInterfaces,
  parseScutilProxy,
  parseVpnServiceList,
  parseZeroTierInterfaces,
  parseZeroTierNetworks,
} from "../parsers/system"

export async function collectNetworkSnapshot(signal?: AbortSignal): Promise<NetworkSnapshot> {
  const zeroTierCli = Bun.which("zerotier-cli")
  const [
    proxyResult,
    routeResult,
    nwiResult,
    listenersResult,
    vpnListResult,
    ifconfigResult,
    hardwareResult,
    dnsResult,
    zeroTierResult,
    zeroTierNetworksResult,
  ] = await Promise.all([
    runCommand("/usr/sbin/scutil", ["--proxy"], 5_000, signal),
    runCommand("/sbin/route", ["-n", "get", "default"], 5_000, signal),
    runCommand("/usr/sbin/scutil", ["--nwi"], 5_000, signal),
    runCommand("/usr/sbin/lsof", ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN"], 5_000, signal),
    runCommand("/usr/sbin/scutil", ["--nc", "list"], 5_000, signal),
    runCommand("/sbin/ifconfig", ["-v", "-a"], 5_000, signal),
    runCommand("/usr/sbin/networksetup", ["-listallhardwareports"], 5_000, signal),
    runCommand("/usr/sbin/scutil", ["--dns"], 5_000, signal),
    runCommand("/usr/bin/pgrep", ["-afil", "ZeroTier|zerotier|MacEthernetTapAgent"], 5_000, signal),
    zeroTierCli
      ? runCommand(zeroTierCli, ["listnetworks", "-j"], 5_000, signal)
      : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  ])

  const errors: string[] = []
  for (const [name, result] of [
    ["scutil --proxy", proxyResult],
    ["route", routeResult],
    ["scutil --nwi", nwiResult],
    ["lsof", listenersResult],
    ["scutil --nc list", vpnListResult],
    ["ifconfig", ifconfigResult],
    ["networksetup", hardwareResult],
    ["scutil --dns", dnsResult],
  ] as const) {
    if (result.exitCode !== 0) errors.push(`${name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }

  const nwiInterfaces = parseNwiInterfaces(nwiResult.stdout)
  const defaultInterface = parseDefaultInterface(routeResult.stdout)
  const vpnServices = await Promise.all(
    parseVpnServiceList(vpnListResult.stdout).map(async (service) => {
      const [show, status] = await Promise.all([
        runCommand("/usr/sbin/scutil", ["--nc", "show", service.id], 5_000, signal),
        runCommand("/usr/sbin/scutil", ["--nc", "status", service.id], 5_000, signal),
      ])
      if (show.exitCode !== 0) errors.push(`scutil --nc show ${service.name}: ${show.stderr.trim() || `exit ${show.exitCode}`}`)
      if (status.exitCode !== 0) errors.push(`scutil --nc status ${service.name}: ${status.stderr.trim() || `exit ${status.exitCode}`}`)
      return enrichVpnService(service, show.stdout, status.stdout)
    }),
  )
  const dnsResolvers = parseDnsResolvers(dnsResult.stdout)
  const overlayNetworks = parseZeroTierNetworks(zeroTierNetworksResult.stdout)
  if (zeroTierCli && zeroTierNetworksResult.exitCode !== 0) {
    errors.push(`zerotier-cli listnetworks: ${zeroTierNetworksResult.stderr.trim() || `exit ${zeroTierNetworksResult.exitCode}`}`)
  } else if (zeroTierNetworksResult.stdout.trim() && overlayNetworks.length === 0) {
    errors.push("zerotier-cli listnetworks: output could not be parsed")
  }
  const zeroTierInterfaces = parseZeroTierInterfaces(zeroTierResult.stdout)
  for (const network of overlayNetworks) zeroTierInterfaces.add(network.interfaceName)
  const inventory = buildInterfaceInventory(
    parseIfconfig(ifconfigResult.stdout),
    parseHardwareInterfaces(hardwareResult.stdout),
    vpnServices,
    zeroTierInterfaces,
    defaultInterface,
    new Set(dnsResolvers.map((resolver) => resolver.interfaceName).filter((name): name is string => Boolean(name))),
    new Map(overlayNetworks.map((network) => [network.interfaceName, `ZeroTier:${network.name}`])),
  )
  const physical = inventory.filter((item) => item.kind === "physical" && item.status === "active").map((item) => item.name)
  return {
    collectedAt: Date.now(),
    proxy: parseScutilProxy(proxyResult.stdout),
    defaultInterface,
    physicalInterfaces:
      physical.length > 0
        ? physical
        : nwiInterfaces.all.filter(
            (name) => !name.startsWith("utun") && !name.startsWith("feth") && name !== "lo0",
          ),
    tunnelInterfaces: inventory.filter((item) => item.kind === "vpn" || item.kind === "tunnel").map((item) => item.name),
    vpnInterfaces: [...new Set([...nwiInterfaces.vpn, ...vpnServices.map((service) => service.interfaceName).filter((name): name is string => Boolean(name))])],
    listeners: parseLsofListeners(listenersResult.stdout),
    vpnServices,
    interfaces: inventory,
    dnsResolvers,
    overlayNetworks,
    errors,
  }
}
