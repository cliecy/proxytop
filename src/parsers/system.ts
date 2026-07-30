import type {
  DnsResolver,
  Listener,
  NetworkInterfaceInfo,
  OverlayNetwork,
  ProxyConfig,
  VpnService,
} from "../domain"

function dictionaryString(output: string, key: string): string | undefined {
  return output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1]
}

function dictionaryBoolean(output: string, key: string): boolean {
  return dictionaryString(output, key) === "1"
}

function dictionaryNumber(output: string, key: string): number | undefined {
  const value = Number(dictionaryString(output, key))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function parseScutilProxy(output: string): ProxyConfig {
  const exceptionsBlock = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? ""
  const exceptions = [...exceptionsBlock.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm)].map(
    (match) => match[1] || "",
  )

  return {
    httpEnabled: dictionaryBoolean(output, "HTTPEnable"),
    httpHost: dictionaryString(output, "HTTPProxy"),
    httpPort: dictionaryNumber(output, "HTTPPort"),
    httpsEnabled: dictionaryBoolean(output, "HTTPSEnable"),
    httpsHost: dictionaryString(output, "HTTPSProxy"),
    httpsPort: dictionaryNumber(output, "HTTPSPort"),
    socksEnabled: dictionaryBoolean(output, "SOCKSEnable"),
    socksHost: dictionaryString(output, "SOCKSProxy"),
    socksPort: dictionaryNumber(output, "SOCKSPort"),
    pacEnabled:
      dictionaryBoolean(output, "ProxyAutoConfigEnable") ||
      dictionaryBoolean(output, "ProxyAutoDiscoveryEnable"),
    exceptions,
  }
}

export function parseDefaultInterface(output: string): string | undefined {
  return output.match(/^\s*interface:\s*(\S+)/m)?.[1]
}

export function parseNwiInterfaces(output: string): {
  all: string[]
  tunnels: string[]
  vpn: string[]
} {
  const all = new Set<string>()
  const vpn = new Set<string>()
  let current: string | undefined

  for (const line of output.split(/\r?\n/)) {
    const interfaceLine = line.match(/^\s*([\w.-]+)\s*:\s*flags/)
    if (interfaceLine?.[1]) {
      current = interfaceLine[1]
      if (current === "REACH") {
        current = undefined
        continue
      }
      all.add(current)
      continue
    }
    if (current && line.includes("VPN server")) vpn.add(current)
  }

  return {
    all: [...all],
    tunnels: [...all].filter((name) => name.startsWith("utun")),
    vpn: [...vpn],
  }
}

export function parseLsofListeners(output: string): Listener[] {
  const listeners: Listener[] = []
  for (const line of output.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 9) continue
    const process = fields[0]
    const pid = Number(fields[1])
    const protocolIndex = fields.indexOf("TCP")
    if (protocolIndex === -1) continue
    const name = fields.slice(protocolIndex).join(" ")
    const endpoint = name.match(/TCP\s+(?:\[([^\]]+)\]|([^: ]+)):(\d+)\s+\(LISTEN\)/)
    if (!process || !Number.isFinite(pid) || !endpoint) continue
    listeners.push({
      process,
      pid,
      user: fields[2],
      host: endpoint[1] || endpoint[2] || "*",
      port: Number(endpoint[3]),
    })
  }
  return listeners
}

export function parseVpnServiceList(output: string): VpnService[] {
  const services: VpnService[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\s*\*?\s*\(([^)]+)\)\s+([0-9A-F-]{36})\s+VPN\s+\(([^)]+)\)\s+"([^"]+)"/i,
    )
    if (!match) continue
    services.push({
      id: match[2] || "",
      name: match[4] || "VPN",
      bundleId: match[3],
      state: match[1] || "Unknown",
      primary: false,
    })
  }
  return services
}

export function enrichVpnService(service: VpnService, showOutput: string, statusOutput: string): VpnService {
  const interfaceNames = [...statusOutput.matchAll(/InterfaceName\s*:\s*(\S+)/g)].map((match) => match[1] || "")
  return {
    ...service,
    providerBundleId: showOutput.match(/NEProviderBundleIdentifier\s*:\s*(\S+)/)?.[1],
    state: statusOutput.match(/^([^\r\n]+)/)?.[1]?.trim() || service.state,
    interfaceName: interfaceNames.find((name) => name.startsWith("utun")) || interfaceNames[0],
    sessionPid: Number(statusOutput.match(/SessionPID\s*:\s*(\d+)/)?.[1]) || undefined,
    serverAddress:
      statusOutput.match(/ServerAddress\s*:\s*(\S+)/)?.[1] ||
      statusOutput.match(/RemoteAddress\s*:\s*(\S+)/)?.[1],
    primary: statusOutput.match(/IsPrimaryInterface\s*:\s*1/) !== null,
  }
}

export function parseHardwareInterfaces(output: string): Map<string, string> {
  const result = new Map<string, string>()
  let port: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const portMatch = line.match(/^Hardware Port:\s*(.+)$/)
    if (portMatch) {
      port = portMatch[1]
      continue
    }
    const device = line.match(/^Device:\s*(\S+)/)?.[1]
    if (port && device) result.set(device, port)
  }
  return result
}

interface RawInterface {
  name: string
  status: "active" | "inactive" | "unknown"
  addresses: string[]
  mtu?: number
  effectiveInterface?: string
  agents: string[]
}

export function parseIfconfig(output: string): RawInterface[] {
  const interfaces: RawInterface[] = []
  let current: RawInterface | undefined
  for (const line of output.split(/\r?\n/)) {
    const start = line.match(/^([\w.-]+):\s+flags=.*?\bmtu\s+(\d+)/)
    if (start?.[1]) {
      current = {
        name: start[1],
        status: "unknown",
        addresses: [],
        mtu: Number(start[2]),
        agents: [],
      }
      interfaces.push(current)
      continue
    }
    if (!current) continue
    const address = line.match(/^\s+inet6?\s+(\S+)/)?.[1]
    if (address && !address.startsWith("127.") && address !== "::1") current.addresses.push(address)
    const status = line.match(/^\s+status:\s*(active|inactive)/)?.[1]
    if (status) current.status = status as "active" | "inactive"
    const effective = line.match(/^\s+effective interface:\s*(\S+)/)?.[1]
    if (effective) current.effectiveInterface = effective
    const agent = line.match(/^\s+agent\s+.*?desc:"([^"]+)"/)?.[1]
    if (agent && agent !== "Userspace Networking") current.agents.push(agent)
    const availability = line.match(/^\s+state availability:\s*\d+\s*\((true|false)\)/)?.[1]
    if (availability && current.status === "unknown") current.status = availability === "true" ? "active" : "inactive"
  }
  return interfaces
}

export function parseZeroTierInterfaces(output: string): Set<string> {
  const interfaces = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const id = line.match(/MacEthernetTapAgent\s+(\d+)\b/)?.[1]
    if (id) interfaces.add(`feth${id}`)
  }
  return interfaces
}

export function parseZeroTierNetworks(output: string): OverlayNetwork[] {
  if (!output.trim()) return []
  try {
    const values = JSON.parse(output) as Array<{
      id?: string
      nwid?: string
      name?: string
      portDeviceName?: string
      status?: string
      assignedAddresses?: string[]
      routes?: Array<{ target?: string; via?: string | null }>
    }>
    return values.flatMap((value) => {
      if (!value.portDeviceName || !(value.id || value.nwid)) return []
      return [{
        provider: "ZeroTier" as const,
        id: value.id || value.nwid || "unknown",
        name: value.name || "unnamed",
        interfaceName: value.portDeviceName,
        status: value.status || "unknown",
        addresses: value.assignedAddresses || [],
        routes: (value.routes || []).map((route) => `${route.target || "?"}${route.via ? ` via ${route.via}` : ""}`),
      }]
    })
  } catch {
    return []
  }
}

export function buildInterfaceInventory(
  raw: RawInterface[],
  hardware: Map<string, string>,
  vpnServices: VpnService[],
  zeroTier: Set<string>,
  defaultInterface: string | undefined,
  dnsInterfaces: Set<string>,
  zeroTierOwners: Map<string, string> = new Map(),
): NetworkInterfaceInfo[] {
  return raw.map((item) => {
    const vpn = vpnServices.find((service) => service.interfaceName === item.name)
    let kind: NetworkInterfaceInfo["kind"] = "virtual"
    let owner: string | undefined
    let ownerConfidence: NetworkInterfaceInfo["ownerConfidence"]
    if (item.name === "lo0") kind = "loopback"
    else if (vpn) {
      kind = "vpn"
      owner = vpn.name
      ownerConfidence = "HIGH"
    } else if (item.name.startsWith("utun")) kind = "tunnel"
    else if (zeroTier.has(item.name)) {
      kind = "zerotier"
      owner = zeroTierOwners.get(item.name) || "ZeroTier"
      ownerConfidence = "HIGH"
    } else if (hardware.has(item.name)) {
      kind = "physical"
      owner = hardware.get(item.name)
      ownerConfidence = "HIGH"
    }
    if (kind === "tunnel" && item.agents.length > 0) {
      owner = item.agents.join(" + ")
      ownerConfidence = "MEDIUM"
    }
    return {
      name: item.name,
      status: vpn?.state === "Connected" ? "active" : item.status,
      addresses: item.addresses,
      mtu: item.mtu,
      effectiveInterface: item.effectiveInterface,
      kind,
      owner,
      ownerConfidence,
      isDefault: item.name === defaultInterface,
      carriesDns: dnsInterfaces.has(item.name),
    }
  })
}

export function parseDnsResolvers(output: string): DnsResolver[] {
  const resolvers: DnsResolver[] = []
  let scopedSection = false
  for (const section of output.split(/\n\s*\n/)) {
    if (section.includes("DNS configuration (for scoped queries)")) {
      scopedSection = true
      continue
    }
    if (!section.match(/^resolver #\d+/m)) continue
    const servers = [...section.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((match) => match[1] || "")
    if (servers.length === 0) continue
    resolvers.push({
      interfaceName: section.match(/if_index\s*:\s*\d+\s*\(([^)]+)\)/)?.[1],
      servers,
      scoped: scopedSection || section.includes("Scoped"),
      supplemental: section.includes("Supplemental"),
    })
  }
  return resolvers
}
