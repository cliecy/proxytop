import { describe, expect, test } from "bun:test"
import type { FlowSample, NetworkSnapshot } from "../src/domain"
import { FlowStore } from "../src/store"

function snapshot(): NetworkSnapshot {
  return {
    collectedAt: Date.now(),
    proxy: {
      httpEnabled: true,
      httpHost: "127.0.0.1",
      httpPort: 1082,
      httpsEnabled: true,
      httpsHost: "127.0.0.1",
      httpsPort: 1082,
      socksEnabled: false,
      pacEnabled: false,
      exceptions: [],
    },
    defaultInterface: "utun6",
    physicalInterfaces: ["en0"],
    tunnelInterfaces: ["utun6"],
    vpnInterfaces: ["utun6"],
    listeners: [{ process: "MacPacketTunnel", pid: 100, host: "127.0.0.1", port: 1082 }],
    vpnServices: [
      {
        id: "vpn",
        name: "Shadowrocket",
        state: "Connected",
        interfaceName: "utun6",
        primary: true,
      },
    ],
    interfaces: [
      {
        name: "en0",
        kind: "physical",
        status: "active",
        addresses: ["192.168.1.2"],
        owner: "Wi-Fi",
        ownerConfidence: "HIGH",
        isDefault: false,
        carriesDns: true,
      },
      {
        name: "utun6",
        kind: "vpn",
        status: "active",
        addresses: ["198.18.0.1"],
        owner: "Shadowrocket",
        ownerConfidence: "HIGH",
        isDefault: true,
        carriesDns: true,
      },
      {
        name: "feth1234",
        kind: "zerotier",
        status: "active",
        addresses: ["10.20.30.40"],
        owner: "ZeroTier",
        ownerConfidence: "HIGH",
        isDefault: false,
        carriesDns: false,
      },
    ],
    dnsResolvers: [],
    overlayNetworks: [],
    errors: [],
  }
}

function flow(overrides: Partial<FlowSample> = {}): FlowSample {
  return {
    timestamp: 1_000,
    pid: 200,
    process: "Example",
    protocol: "tcp",
    family: 4,
    local: { raw: "192.168.1.2:50000", host: "192.168.1.2", port: 50000 },
    remote: { raw: "8.8.8.8:443", host: "8.8.8.8", port: 443 },
    interfaceName: "en0",
    bytesIn: 0,
    bytesOut: 0,
    ...overrides,
  }
}

describe("flow store", () => {
  test("uses sample time for rates and ignores implausibly short intervals", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.upsert(flow())
    store.upsert(flow({ timestamp: 2_000, bytesIn: 1_000_000, bytesOut: 500_000 }))
    expect(store.list()[0]).toMatchObject({ rateIn: 1_000_000, rateOut: 500_000 })

    store.upsert(flow({ timestamp: 2_010, bytesIn: 2_000_000, bytesOut: 1_000_000 }))
    expect(store.list()[0]).toMatchObject({ rateIn: 0, rateOut: 0 })
  })

  test("zeros a disappeared flow rate before retaining its evidence", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.upsert(flow())
    store.upsert(flow({ timestamp: 2_000, bytesIn: 10_000, bytesOut: 5_000 }))
    expect(store.wanTotals()).toEqual({ rateIn: 10_000, rateOut: 5_000 })
    store.tick(4_501)
    expect(store.list()).toHaveLength(1)
    expect(store.wanTotals()).toEqual({ rateIn: 0, rateOut: 0 })
  })

  test("WAN totals exclude local proxy and tunnel copies", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    const samples: FlowSample[] = [
      flow({
        process: "App",
        local: { raw: "127.0.0.1:50000", host: "127.0.0.1", port: 50000 },
        remote: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 },
        interfaceName: "lo0",
      }),
      flow({
        process: "App",
        local: { raw: "198.18.0.1:50001", host: "198.18.0.1", port: 50001 },
        remote: { raw: "198.18.0.8:443", host: "198.18.0.8", port: 443 },
        interfaceName: "utun6",
      }),
      flow({ process: "MacPacketTunnel", pid: 100 }),
    ]
    for (const sample of samples) store.upsert(sample)
    for (const sample of samples) {
      store.upsert({ ...sample, timestamp: 2_000, bytesIn: 1_000, bytesOut: 500 })
    }
    expect(store.totals()).toEqual({ rateIn: 3_000, rateOut: 1_500 })
    expect(store.wanTotals()).toEqual({ rateIn: 1_000, rateOut: 500 })
  })

  test("aggregates CGNAT and IPv6 ULA traffic as local", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    const samples = [
      flow({
        process: "LocalOnly",
        remote: { raw: "100.64.1.2:443", host: "100.64.1.2", port: 443 },
      }),
      flow({
        process: "LocalOnly",
        family: 6,
        local: { raw: "[fd00::2]:50001", host: "fd00::2", port: 50001 },
        remote: { raw: "[fd00::1]:443", host: "fd00::1", port: 443 },
      }),
    ]
    for (const sample of samples) store.upsert(sample)
    for (const sample of samples) {
      store.upsert({ ...sample, timestamp: 2_000, bytesIn: 1_000, bytesOut: 500 })
    }
    expect(store.apps().find((app) => app.process === "LocalOnly")).toMatchObject({
      verdict: "LOCAL",
      paths: ["LAN"],
      rateIn: 2_000,
      rateOut: 1_000,
    })
    expect(store.wanTotals()).toEqual({ rateIn: 0, rateOut: 0 })
  })

  test("ENGINE app rates count only physical outer sockets", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    const outer = flow({ process: "MacPacketTunnel", pid: 100 })
    const loopback = flow({
      process: "MacPacketTunnel",
      pid: 100,
      local: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 },
      remote: { raw: "127.0.0.1:50001", host: "127.0.0.1", port: 50001 },
      interfaceName: "lo0",
    })
    store.upsert(outer)
    store.upsert(loopback)
    store.upsert({ ...outer, timestamp: 2_000, bytesIn: 1_000, bytesOut: 500 })
    store.upsert({ ...loopback, timestamp: 2_000, bytesIn: 1_000, bytesOut: 500 })
    expect(store.apps().find((app) => app.process === "MacPacketTunnel")).toMatchObject({
      verdict: "ENGINE",
      rateIn: 1_000,
      rateOut: 500,
    })
  })

  test("summarizes proxy port, protocol, tunnel owner, and mixed routing", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.setRegionLookup((host) => (host === "8.8.8.8" ? "US" : undefined))
    store.upsert(
      flow({
        process: "opencode.exe",
        local: { raw: "127.0.0.1:51000", host: "127.0.0.1", port: 51000 },
        remote: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 },
        interfaceName: "lo0",
      }),
    )
    store.upsert(flow({ process: "opencode.exe", local: { raw: "192.168.1.2:52000", host: "192.168.1.2", port: 52000 } }))

    const app = store.apps().find((candidate) => candidate.process === "opencode.exe")
    expect(app).toMatchObject({
      verdict: "MIXED",
      proxyHops: ["127.0.0.1:1082 -> MacPacketTunnel"],
      proxyProtocols: ["HTTP", "HTTPS CONNECT"],
      regions: ["US"],
    })
  })

  test("classifies ZeroTier traffic as an overlay", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.upsert(
      flow({
        process: "ssh",
        remote: { raw: "10.20.30.41:22", host: "10.20.30.41", port: 22 },
        interfaceName: "feth1234",
      }),
    )
    expect(store.apps()[0]).toMatchObject({
      verdict: "OVERLAY",
      paths: ["OVERLAY"],
      tunnelOwners: ["ZeroTier/feth1234"],
    })
  })

  test("uses a Clash controller decision to expose the exact rule and chain", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.setRegionLookup((host) => (host === "8.8.8.8" ? "US" : undefined))
    store.setControllerSnapshot({
      kind: "clash",
      url: "http://127.0.0.1:9090",
      collectedAt: Date.now(),
      connections: [
        {
          id: "flow",
          process: "opencode.exe",
          sourcePort: 50000,
          destinationIp: "8.8.8.8",
          destinationPort: 443,
          host: "api.example.com",
          network: "tcp",
          rule: "DOMAIN-SUFFIX",
          rulePayload: "example.com",
          chains: ["US Auto", "Proxy"],
          upload: 0,
          download: 0,
        },
      ],
    })
    store.upsert(flow({ process: "opencode.exe" }))
    expect(store.apps()[0]).toMatchObject({
      verdict: "PROXIED",
      proxyChains: ["US Auto -> Proxy"],
      rules: ["DOMAIN-SUFFIX(example.com)"],
      destinations: ["api.example.com"],
      regions: ["US"],
    })
  })

  test("does not join a controller source port owned by another process", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.setControllerSnapshot({
      kind: "clash",
      url: "http://127.0.0.1:9090",
      collectedAt: Date.now(),
      connections: [
        {
          id: "other",
          process: "curl",
          sourcePort: 50000,
          chains: ["Proxy"],
          upload: 0,
          download: 0,
        },
      ],
    })
    store.upsert(flow({ process: "opencode.exe" }))
    expect(store.apps()[0]).toMatchObject({ verdict: "DIRECT", proxyChains: [], rules: [] })
  })

  test("does not join a stale controller decision", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.setControllerSnapshot({
      kind: "clash",
      url: "http://127.0.0.1:9090",
      collectedAt: Date.now() - 10_000,
      connections: [
        {
          id: "stale",
          process: "opencode.exe",
          sourcePort: 50000,
          network: "tcp",
          chains: ["Proxy"],
          upload: 0,
          download: 0,
        },
      ],
    })
    store.upsert(flow({ process: "opencode.exe" }))
    expect(store.apps()[0]).toMatchObject({ verdict: "DIRECT", proxyChains: [] })
  })

  test("reclassifies existing flows when the snapshot changes", () => {
    const store = new FlowStore()
    store.setSnapshot({
      ...snapshot(),
      vpnInterfaces: [],
      defaultInterface: "en0",
      interfaces: snapshot().interfaces.map((item) =>
        item.name === "utun6" ? { ...item, kind: "tunnel", owner: undefined, isDefault: false } : item,
      ),
    })
    store.upsert(
      flow({
        process: "Browser",
        remote: { raw: "1.1.1.1:443", host: "1.1.1.1", port: 443 },
        interfaceName: "utun6",
      }),
    )
    expect(store.list()[0]?.path).toBe("UNKNOWN")

    store.setSnapshot(snapshot())
    expect(store.list()[0]?.path).toBe("TUNNELED")
  })

  test("backfills missing interfaces from route lookup results", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.upsert(
      flow({
        process: "curl",
        remote: { raw: "8.8.8.8:443", host: "8.8.8.8", port: 443 },
        interfaceName: undefined,
      }),
    )
    expect(store.list()[0]?.path).toBe("UNKNOWN")
    store.backfillInterface("8.8.8.8", "en0")
    expect(store.list()[0]).toMatchObject({ interfaceName: "en0", path: "DIRECT" })
  })

  test("exposes control mechanism and discovered proxy engines", () => {
    const store = new FlowStore()
    store.setSnapshot({
      ...snapshot(),
      listeners: [
        ...snapshot().listeners,
        { process: "AirportShell", pid: 400, host: "127.0.0.1", port: 7890 },
      ],
    })
    store.upsert(
      flow({
        process: "curl",
        local: { raw: "127.0.0.1:52000", host: "127.0.0.1", port: 52000 },
        remote: { raw: "127.0.0.1:7890", host: "127.0.0.1", port: 7890 },
        interfaceName: "lo0",
      }),
    )
    store.upsert(
      flow({
        process: "OrbStack",
        remote: { raw: "1.1.1.1:443", host: "1.1.1.1", port: 443 },
        interfaceName: "bridge100",
      }),
    )
    const engines = store.engines()
    expect(engines.some((engine) => engine.process === "AirportShell")).toBe(true)
    expect(store.apps().find((app) => app.process === "curl")).toMatchObject({
      verdict: "PROXIED",
      control: "local-proxy",
    })
    expect(store.apps().find((app) => app.process === "OrbStack")).toMatchObject({
      verdict: "DIRECT",
      control: "direct",
    })
    expect(store.apps().find((app) => app.process === "OrbStack")?.mechanism).toContain("not proxied")
  })

  test("records VPN/proxy node countries separately from target countries", () => {
    const store = new FlowStore()
    const base = snapshot()
    store.setSnapshot({
      ...base,
      vpnServices: [
        {
          ...base.vpnServices[0]!,
          serverAddress: "203.0.113.10",
        },
      ],
    })
    store.setRegionLookup((host) => {
      if (host === "203.0.113.10") return "JP"
      if (host === "8.8.8.8") return "US"
      if (host === "9.9.9.9") return "CH"
      return undefined
    })
    store.upsert(
      flow({
        process: "Browser",
        remote: { raw: "1.1.1.1:443", host: "1.1.1.1", port: 443 },
        interfaceName: "utun6",
      }),
    )
    store.upsert(
      flow({
        process: "MacPacketTunnel",
        pid: 100,
        remote: { raw: "9.9.9.9:443", host: "9.9.9.9", port: 443 },
        interfaceName: "en0",
      }),
    )
    store.upsert(
      flow({
        process: "App",
        local: { raw: "127.0.0.1:51000", host: "127.0.0.1", port: 51000 },
        remote: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 },
        interfaceName: "lo0",
      }),
    )

    expect(store.apps().find((app) => app.process === "Browser")).toMatchObject({
      verdict: "PROXIED",
      nodeRegions: ["JP"],
    })
    expect(store.apps().find((app) => app.process === "App")).toMatchObject({
      verdict: "PROXIED",
      nodeRegions: ["CH"],
    })
  })

  test("ignores unconnected sockets when building app coverage", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.upsert(
      flow({
        process: "Listener",
        remote: { raw: "*:*", host: "*" },
        interfaceName: undefined,
      }),
    )
    store.upsert(
      flow({
        process: "Browser",
        remote: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 },
        interfaceName: "lo0",
      }),
    )
    const apps = store.apps()
    expect(apps.find((app) => app.process === "Listener")).toBeUndefined()
    expect(apps.find((app) => app.process === "Browser")?.verdict).toBe("PROXIED")
  })

  test("does not join a UDP controller decision to a TCP flow sharing its port", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.setControllerSnapshot({
      kind: "clash",
      url: "http://127.0.0.1:9090",
      collectedAt: Date.now(),
      connections: [
        {
          id: "udp",
          process: "opencode.exe",
          sourceIp: "192.168.1.2",
          sourcePort: 50000,
          network: "udp",
          chains: ["Proxy"],
          upload: 0,
          download: 0,
        },
      ],
    })
    store.upsert(flow({ process: "opencode.exe", protocol: "tcp" }))
    expect(store.apps()[0]).toMatchObject({ verdict: "DIRECT", proxyChains: [] })
  })
})
