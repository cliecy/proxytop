import { describe, expect, test } from "bun:test"
import type { NetworkSnapshot } from "../src/domain"
import { collectNetworkSnapshot, mergeNetworkSnapshot } from "../src/collectors/system"
import {
  buildInterfaceInventory,
  enrichVpnService,
  parseIfconfig,
  parseLsofListeners,
  parseNwiInterfaces,
  parseScutilProxy,
  parseZeroTierNetworks,
} from "../src/parsers/system"

describe("macOS system parsers", () => {
  test("parses active proxy settings and exceptions", () => {
    const proxy = parseScutilProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 10.0.0.0/8
  }
  HTTPEnable : 1
  HTTPPort : 1082
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 1082
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`)
    expect(proxy).toMatchObject({
      httpEnabled: true,
      httpHost: "127.0.0.1",
      httpPort: 1082,
      httpsEnabled: true,
      socksEnabled: false,
      exceptions: ["localhost", "10.0.0.0/8"],
    })
  })

  test("separates VPN, tunnel, and physical interfaces", () => {
    const parsed = parseNwiInterfaces(`
   utun6 : flags : 0x7
           VPN server : 127.0.0.1
     en0 : flags : 0x7
   REACH : flags 0x3
`)
    expect(parsed).toEqual({ all: ["utun6", "en0"], tunnels: ["utun6"], vpn: ["utun6"] })
  })

  test("parses wildcard, IPv4, and IPv6 listeners", () => {
    const listeners = parseLsofListeners(`COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
MacPacket 34031 user 11u IPv4 0x1 0t0 TCP *:1082 (LISTEN)
MacPacket 34031 user 12u IPv4 0x2 0t0 TCP 127.0.0.1:1082 (LISTEN)
MacPacket 34031 user 13u IPv6 0x3 0t0 TCP [::1]:1082 (LISTEN)`)
    expect(listeners).toHaveLength(3)
    expect(listeners[2]).toEqual({ process: "MacPacket", pid: 34031, user: "user", host: "::1", port: 1082 })
  })

  test("prefers the VPN utun over excluded-route interfaces", () => {
    const service = enrichVpnService(
      { id: "id", name: "Example", state: "Connected", primary: false },
      "NEProviderBundleIdentifier : com.example.PacketTunnel",
      `Connected
ExcludedRoutes : <array> {
  InterfaceName : en0
}
IPv4 : <dictionary> {
  InterfaceName : utun6
}
IsPrimaryInterface : 1`,
    )
    expect(service.interfaceName).toBe("utun6")
    expect(service.primary).toBe(true)
  })

  test("attributes system utuns from verbose network agents", () => {
    const raw = parseIfconfig(`utun1: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500 index 26
  inet6 fe80::1%utun1 prefixlen 64
  agent domain:com.apple.rapport type:RapportNetworkAgent flags:0x7c3 desc:"Rapport Network Agent"
  state availability: 0 (true)
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 4064 index 32
  inet 198.18.0.1 --> 198.18.0.1
  agent domain:NetworkExtension type:VPN flags:0x3 desc:"VPN: Shadowrocket"
  effective interface: en0
  state availability: 0 (true)`)
    const inventory = buildInterfaceInventory(
      raw,
      new Map(),
      [{ id: "vpn", name: "Shadowrocket", state: "Connected", interfaceName: "utun6", primary: true }],
      new Set(),
      "utun6",
      new Set(["utun6"]),
    )
    expect(inventory[0]).toMatchObject({
      name: "utun1",
      kind: "tunnel",
      owner: "Rapport Network Agent",
      ownerConfidence: "MEDIUM",
      status: "active",
    })
    expect(inventory[1]).toMatchObject({
      name: "utun6",
      kind: "vpn",
      owner: "Shadowrocket",
      ownerConfidence: "HIGH",
      effectiveInterface: "en0",
      isDefault: true,
      carriesDns: true,
      status: "active",
    })
  })

  test("parses multiple ZeroTier networks and their interfaces", () => {
    const networks = parseZeroTierNetworks(JSON.stringify([
      {
        id: "abc123",
        name: "work",
        portDeviceName: "feth1001",
        status: "OK",
        assignedAddresses: ["10.1.0.2/24"],
        routes: [{ target: "10.1.0.0/24", via: null }],
      },
      {
        nwid: "def456",
        name: "lab",
        portDeviceName: "feth1002",
        status: "OK",
        assignedAddresses: ["172.20.0.2/16"],
        routes: [{ target: "172.20.0.0/16", via: "10.1.0.1" }],
      },
    ]))
    expect(networks).toEqual([
      {
        provider: "ZeroTier",
        id: "abc123",
        name: "work",
        interfaceName: "feth1001",
        status: "OK",
        addresses: ["10.1.0.2/24"],
        routes: ["10.1.0.0/24"],
      },
      {
        provider: "ZeroTier",
        id: "def456",
        name: "lab",
        interfaceName: "feth1002",
        status: "OK",
        addresses: ["172.20.0.2/16"],
        routes: ["172.20.0.0/16 via 10.1.0.1"],
      },
    ])
  })

  test("keeps multiple simultaneous VPN interfaces attributed independently", () => {
    const raw = parseIfconfig(`utun6: flags=8051<UP,RUNNING> mtu 1400
  inet 198.18.0.1
  state availability: 0 (true)
utun7: flags=8051<UP,RUNNING> mtu 1280
  inet 10.8.0.2
  state availability: 0 (true)`)
    const inventory = buildInterfaceInventory(
      raw,
      new Map(),
      [
        { id: "one", name: "Shadowrocket", state: "Connected", interfaceName: "utun6", primary: true },
        { id: "two", name: "Work VPN", state: "Connected", interfaceName: "utun7", primary: false },
      ],
      new Set(),
      "utun6",
      new Set(["utun6", "utun7"]),
    )
    expect(inventory.map((item) => ({ name: item.name, owner: item.owner, primary: item.isDefault }))).toEqual([
      { name: "utun6", owner: "Shadowrocket", primary: true },
      { name: "utun7", owner: "Work VPN", primary: false },
    ])
  })

  test("pure merge preserves failed sources but clears successful empty results", () => {
    const previous = {
      collectedAt: 1, proxy: { httpEnabled: true, httpsEnabled: false, socksEnabled: false, pacEnabled: false, exceptions: [] },
      defaultInterface: "en0", physicalInterfaces: ["en0"], tunnelInterfaces: ["utun1"], vpnInterfaces: ["utun1"],
      listeners: [{ process: "old", pid: 1, host: "*", port: 80 }], vpnServices: [], interfaces: [], dnsResolvers: [], overlayNetworks: [], errors: ["old"],
    } satisfies NetworkSnapshot
    const current = { ...previous, collectedAt: 2, proxy: { httpEnabled: false, httpsEnabled: false, socksEnabled: false, pacEnabled: false, exceptions: [] }, listeners: [], errors: ["new"] }
    const merged = mergeNetworkSnapshot(current, previous, { proxy: true })
    expect(merged.proxy).toBe(previous.proxy)
    expect(merged.listeners).toEqual([])
    expect(merged.errors).toEqual(["new"])
  })

  test("collector accepts a successful empty ZeroTier list and clears stale networks", async () => {
    const previous = {
      collectedAt: 1, proxy: { httpEnabled: false, httpsEnabled: false, socksEnabled: false, pacEnabled: false, exceptions: [] },
      physicalInterfaces: [], tunnelInterfaces: [], vpnInterfaces: [], listeners: [], vpnServices: [], interfaces: [], dnsResolvers: [],
      overlayNetworks: [{ provider: "ZeroTier", id: "old", name: "Old", interfaceName: "feth1", status: "OK", addresses: [], routes: [] }], errors: [],
    } satisfies NetworkSnapshot
    const result = await collectNetworkSnapshot(undefined, previous, {
      which: () => "/usr/local/bin/zerotier-cli",
      runCommand: async (command) => command.includes("zerotier-cli")
        ? { stdout: "[]", stderr: "", exitCode: 0 }
        : command.endsWith("pgrep")
          ? { stdout: "", stderr: "", exitCode: 1 }
          : { stdout: "", stderr: "", exitCode: 0 },
    })
    expect(result.overlayNetworks).toEqual([])
    expect(result.errors).toEqual([])
  })

  test("collector keeps previous source on failure and treats pgrep exit 1 as empty", async () => {
    const previous = {
      collectedAt: 1, proxy: { httpEnabled: true, httpsEnabled: false, socksEnabled: false, pacEnabled: false, exceptions: [] },
      defaultInterface: "en0", physicalInterfaces: ["en0"], tunnelInterfaces: [], vpnInterfaces: [], listeners: [], vpnServices: [], interfaces: [], dnsResolvers: [], overlayNetworks: [], errors: ["old"],
    } satisfies NetworkSnapshot
    const result = await collectNetworkSnapshot(undefined, previous, {
      which: () => null, now: () => 99,
      runCommand: async (command, args) => {
        if (args[0] === "--proxy") return { stdout: "", stderr: "x".repeat(600), exitCode: 2 }
        if (command.endsWith("pgrep")) return { stdout: "", stderr: "", exitCode: 1 }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    })
    expect(result.collectedAt).toBe(99)
    expect(result.proxy).toBe(previous.proxy)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.length).toBe(512)
  })
})
