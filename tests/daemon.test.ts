import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { FlowSample, NetworkSnapshot } from "../src/domain"
import { ProxyEngine } from "../src/engine"
import { GeoResolver } from "../src/geo"
import { FlowStore } from "../src/store"
import {
  bearerAuthorized,
  buildBanner,
  buildSnapshot,
  socketPath,
} from "../src/daemon"

function snapshot(): NetworkSnapshot {
  return {
    collectedAt: 1_000,
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
        isDefault: false,
        carriesDns: true,
      },
      {
        name: "utun6",
        kind: "vpn",
        status: "active",
        addresses: ["198.18.0.1"],
        owner: "Shadowrocket",
        isDefault: true,
        carriesDns: true,
      },
    ],
    dnsResolvers: [],
    overlayNetworks: [],
    errors: ["collector failed"],
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

function engineWith(store: FlowStore): ProxyEngine {
  return new ProxyEngine(store, new GeoResolver())
}

describe("daemon IPC", () => {
  test("socket path lives under the user Library with private perms", () => {
    expect(socketPath()).toBe(
      join(homedir(), "Library", "Application Support", "Proxytop", "engine.sock"),
    )
  })

  test("banner exposes socket and token as parseable env lines", () => {
    const banner = buildBanner("/tmp/engine.sock", "abc123")
    const lines = banner.trim().split("\n")
    expect(lines).toEqual([
      "PROXYTOP_SOCKET=/tmp/engine.sock",
      "PROXYTOP_TOKEN=abc123",
    ])
  })

  test("authorization requires an exact bearer token", () => {
    expect(bearerAuthorized(null, "secret")).toBe(false)
    expect(bearerAuthorized("Basic abc", "secret")).toBe(false)
    expect(bearerAuthorized("Bearer wrong", "secret")).toBe(false)
    expect(bearerAuthorized("Bearer secret", "secret")).toBe(true)
  })

  test("buildSnapshot serializes the full IPC contract", () => {
    const store = new FlowStore()
    store.setSnapshot(snapshot())
    store.setRegionLookup((host) => (host === "8.8.8.8" ? "US" : undefined))
    store.upsert(flow())
    store.upsert({ ...flow(), timestamp: 2_000, bytesIn: 10_000, bytesOut: 5_000 })

    const engine = engineWith(store)
    engine.setStatus("nettop", "active")
    engine.setStatus("snapshot", "snapshot error: test")
    engine.setStatus("clash", "not detected")
    const payload = buildSnapshot(store, engine, "offline country DB ready", 2_500)

    expect(payload.kind).toBe("snapshot")
    expect(payload.errors).toEqual(["collector failed"])
    expect(payload.collectedAt).toBe(2_500)
    expect(payload.wanRate).toEqual({ in: 10_000, out: 5_000 })
    expect(payload.history).toEqual({ inbound: [], outbound: [] })
    expect(payload.statuses).toMatchObject({
      nettop: "active",
      snapshot: "snapshot error: test",
      clash: "not detected",
      pktap: "off",
      geo: "offline country DB ready",
    })

    expect(payload.header).not.toBeNull()
    expect(payload.header?.defaultInterface).toBe("utun6")
    expect(payload.header?.vpnServices).toEqual([
      { name: "Shadowrocket", state: "Connected", interfaceName: "utun6", serverAddress: undefined, primary: true },
    ])
    expect(payload.header?.interfaces).toHaveLength(2)

    const app = payload.apps.find((item) => item.process === "Example")
    expect(app).toMatchObject({
      verdict: "DIRECT",
      regions: ["US"],
      rateIn: 10_000,
      rateOut: 5_000,
      control: "direct",
    })
    expect(app).toHaveProperty("paths")
    expect(app).toHaveProperty("confidence")
    expect(app).toHaveProperty("mechanism")
    expect(payload.engines.length).toBeGreaterThan(0)
  })

  test("matches the shared Swift daemon contract fixture", () => {
    const store = new FlowStore()
    store.setSnapshot({
      collectedAt: 1_000,
      proxy: { httpEnabled: false, httpsEnabled: false, socksEnabled: false, pacEnabled: false, exceptions: [] },
      defaultInterface: "en0",
      physicalInterfaces: ["en0"],
      tunnelInterfaces: [],
      vpnInterfaces: [],
      listeners: [],
      vpnServices: [],
      interfaces: [{
        name: "en0",
        kind: "physical",
        status: "active",
        addresses: ["192.168.1.2"],
        owner: "Wi-Fi",
        isDefault: true,
        carriesDns: true,
      }],
      dnsResolvers: [],
      overlayNetworks: [],
      errors: ["lsof: test failure", "route: test failure"],
    })
    store.setRegionLookup((host) => (host === "8.8.8.8" ? "US" : undefined))
    store.setControllerSnapshot({
      kind: "clash",
      url: "http://127.0.0.1:9090",
      collectedAt: Date.now(),
      connections: [{
        id: "direct",
        process: "BypassApp",
        sourceIp: "192.168.1.2",
        sourcePort: 50_000,
        destinationIp: "8.8.8.8",
        destinationPort: 443,
        host: "example.com",
        network: "tcp",
        rule: "MATCH",
        chains: [],
        upload: 0,
        download: 0,
      }],
    })
    store.upsert(flow({
      pid: 42,
      process: "BypassApp",
      local: { raw: "192.168.1.2:50000", host: "192.168.1.2", port: 50_000 },
    }))
    const engine = engineWith(store)
    engine.setStatus("nettop", "active")
    engine.setStatus("clash", "active")
    engine.setStatus("snapshot", "degraded (2 errors)")
    const payload = buildSnapshot(store, engine, "offline country DB ready", 1_730_000_000_000)
    const expected = JSON.parse(readFileSync(resolve(import.meta.dir, "../app/Tests/ProxytopTests/Fixtures/daemon-snapshot.json"), "utf8"))
    expect(payload).toEqual(expected)
  })

  test("buildSnapshot handles a missing snapshot with an empty header", () => {
    const store = new FlowStore()
    const payload = buildSnapshot(store, engineWith(store), "not installed", 1)
    expect(payload.apps).toEqual([])
    expect(payload.engines).toEqual([])
    expect(payload.header).toBeNull()
    expect(payload.errors).toEqual([])
    expect(payload.wanRate).toEqual({ in: 0, out: 0 })
  })
})
