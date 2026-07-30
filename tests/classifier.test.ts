import { describe, expect, test } from "bun:test"
import { classifyFlow } from "../src/classifier"
import type { FlowSample, NetworkSnapshot } from "../src/domain"

const snapshot: NetworkSnapshot = {
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
  tunnelInterfaces: ["utun6", "utun4"],
  vpnInterfaces: ["utun6"],
  listeners: [{ process: "MacPacket", pid: 100, host: "127.0.0.1", port: 1082 }],
  vpnServices: [
    {
      id: "test-vpn",
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
  ],
  dnsResolvers: [{ interfaceName: "utun6", servers: ["198.18.0.2"], scoped: false, supplemental: true }],
  overlayNetworks: [],
  errors: [],
}

function flow(overrides: Partial<FlowSample>): FlowSample {
  return {
    timestamp: Date.now(),
    pid: 200,
    process: "Example",
    protocol: "tcp",
    family: 4,
    local: { raw: "127.0.0.1:50000", host: "127.0.0.1", port: 50000 },
    remote: { raw: "8.8.8.8:443", host: "8.8.8.8", port: 443 },
    interfaceName: "en0",
    bytesIn: 0,
    bytesOut: 0,
    ...overrides,
  }
}

describe("flow classifier", () => {
  const context = { snapshot, proxyProcesses: new Set(["MacPacket"]) }

  test("recognizes a local proxy hop", () => {
    const result = classifyFlow(
      flow({ remote: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 }, interfaceName: "lo0" }),
      context,
    )
    expect(result.path).toBe("LOCAL_PROXY")
    expect(result.confidence).toBe("HIGH")
  })

  test("does not mistake an unrelated loopback listener for a proxy", () => {
    const localSnapshot = {
      ...snapshot,
      listeners: [...snapshot.listeners, { process: "zotero", pid: 300, host: "127.0.0.1", port: 23119 }],
    }
    const result = classifyFlow(
      flow({ remote: { raw: "127.0.0.1:23119", host: "127.0.0.1", port: 23119 }, interfaceName: "lo0" }),
      { snapshot: localSnapshot, proxyProcesses: new Set(["MacPacket"]) },
    )
    expect(result.path).toBe("LAN")
  })

  test("ignores stale ports from disabled proxy settings", () => {
    const disabledSnapshot: NetworkSnapshot = {
      ...snapshot,
      proxy: {
        ...snapshot.proxy,
        httpEnabled: false,
        httpsEnabled: false,
      },
      listeners: [],
    }
    const result = classifyFlow(
      flow({ remote: { raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 }, interfaceName: "lo0" }),
      { snapshot: disabledSnapshot, proxyProcesses: new Set() },
    )
    expect(result.path).toBe("LAN")
  })

  test("matches both host and port for a remote explicit proxy", () => {
    const remoteSnapshot: NetworkSnapshot = {
      ...snapshot,
      proxy: {
        ...snapshot.proxy,
        httpHost: "proxy.example.com",
        httpsHost: "proxy.example.com",
      },
      listeners: [],
    }
    const context = { snapshot: remoteSnapshot, proxyProcesses: new Set<string>() }
    expect(
      classifyFlow(
        flow({ remote: { raw: "proxy.example.com:1082", host: "proxy.example.com", port: 1082 } }),
        context,
      ).path,
    ).toBe("LOCAL_PROXY")
    expect(
      classifyFlow(flow({ remote: { raw: "8.8.8.8:1082", host: "8.8.8.8", port: 1082 } }), context).path,
    ).toBe("UNKNOWN")
  })

  test("recognizes the active default VPN tunnel", () => {
    const result = classifyFlow(flow({ interfaceName: "utun6" }), context)
    expect(result.path).toBe("TUNNELED")
    expect(result.confidence).toBe("HIGH")
  })

  test("keeps private destinations on a VPN classified as tunneled", () => {
    const result = classifyFlow(
      flow({
        remote: { raw: "10.20.30.40:443", host: "10.20.30.40", port: 443 },
        interfaceName: "utun6",
      }),
      context,
    )
    expect(result.path).toBe("TUNNELED")
  })

  test("does not claim a route for an unconnected wildcard socket", () => {
    const result = classifyFlow(
      flow({ remote: { raw: "*:*", host: "*" }, interfaceName: "en0" }),
      context,
    )
    expect(result.path).toBe("UNKNOWN")
    expect(result.confidence).toBe("LOW")
  })

  test("keeps strong interface attribution for wildcard sockets", () => {
    const overlaySnapshot: NetworkSnapshot = {
      ...snapshot,
      interfaces: [
        ...snapshot.interfaces,
        {
          name: "feth1234",
          kind: "zerotier",
          status: "active",
          addresses: ["10.20.30.40"],
          owner: "ZeroTier:work",
          ownerConfidence: "HIGH",
          isDefault: false,
          carriesDns: false,
        },
      ],
    }
    expect(
      classifyFlow(
        flow({ remote: { raw: "*:*", host: "*" }, interfaceName: "feth1234", protocol: "udp" }),
        { snapshot: overlaySnapshot, proxyProcesses: new Set() },
      ).path,
    ).toBe("OVERLAY")
    expect(
      classifyFlow(
        flow({ remote: { raw: "*:*", host: "*" }, interfaceName: "utun6", protocol: "udp" }),
        context,
      ).path,
    ).toBe("TUNNELED")
    expect(
      classifyFlow(
        flow({ process: "MacPacketTunnel", remote: { raw: "*:*", host: "*" }, interfaceName: "en0", protocol: "udp" }),
        context,
      ).path,
    ).toBe("PROXY_OUTBOUND")
  })

  test("does not report proxy engine outbound traffic as a leak", () => {
    const result = classifyFlow(flow({ process: "MacPacketTunnel", interfaceName: "en0" }), context)
    expect(result.path).toBe("PROXY_OUTBOUND")
  })

  test("recognizes ordinary physical-interface traffic as direct", () => {
    expect(classifyFlow(flow({ interfaceName: "en0" }), context).path).toBe("DIRECT")
  })

  test("recognizes a ZeroTier interface before private-address LAN classification", () => {
    const overlaySnapshot: NetworkSnapshot = {
      ...snapshot,
      interfaces: [
        ...snapshot.interfaces,
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
    }
    const result = classifyFlow(
      flow({
        remote: { raw: "10.20.30.41:22", host: "10.20.30.41", port: 22 },
        interfaceName: "feth1234",
      }),
      { snapshot: overlaySnapshot, proxyProcesses: new Set() },
    )
    expect(result.path).toBe("OVERLAY")
    expect(result.confidence).toBe("HIGH")
  })

  test("preserves an attributed non-VPN system tunnel owner", () => {
    const systemTunnelSnapshot: NetworkSnapshot = {
      ...snapshot,
      interfaces: [
        ...snapshot.interfaces,
        {
          name: "utun1",
          kind: "tunnel",
          status: "active",
          addresses: ["fe80::1%utun1"],
          owner: "Rapport Network Agent",
          ownerConfidence: "MEDIUM",
          isDefault: false,
          carriesDns: false,
        },
      ],
    }
    const result = classifyFlow(
      flow({
        remote: { raw: "fe80::2%utun1.1024", host: "fe80::2%utun1", port: 1024 },
        interfaceName: "utun1",
        family: 6,
      }),
      { snapshot: systemTunnelSnapshot, proxyProcesses: new Set() },
    )
    expect(result.path).toBe("OVERLAY")
    expect(result.evidence.join(" ")).toContain("Rapport Network Agent")
  })
})
