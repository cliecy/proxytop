import { describe, expect, test } from "bun:test"
import { controllerOwnerForUrl, discoverClashController, parseClashConnections } from "../src/collectors/clash"
import { userInfo } from "node:os"

describe("Clash-compatible controller", () => {
  test("normalizes connection metadata, rules, and chains", () => {
    const connections = parseClashConnections({
      connections: [
        {
          id: "flow-1",
          metadata: {
            process: "opencode.exe",
            sourceIP: "127.0.0.1",
            sourcePort: "51234",
            destinationIP: "8.8.8.8",
            destinationPort: "443",
            host: "api.example.com",
            network: "tcp",
          },
          rule: "DOMAIN-SUFFIX",
          rulePayload: "example.com",
          chains: ["US Auto", "Proxy"],
          upload: 100,
          download: 200,
        },
      ],
    })
    expect(connections).toEqual([
      {
        id: "flow-1",
        process: "opencode.exe",
        sourceIp: "127.0.0.1",
        sourcePort: 51234,
        destinationIp: "8.8.8.8",
        destinationPort: 443,
        host: "api.example.com",
        network: "tcp",
        rule: "DOMAIN-SUFFIX",
        rulePayload: "example.com",
        chains: ["US Auto", "Proxy"],
        upload: 100,
        download: 200,
      },
    ])
  })

  test("discovers only standard local ports owned by known proxy processes", () => {
    const previous = Bun.env.PROXYTOP_CLASH_CONTROLLER
    delete Bun.env.PROXYTOP_CLASH_CONTROLLER
    try {
      expect(
        discoverClashController([
          { process: "zotero", pid: 1, host: "127.0.0.1", port: 9090 },
          { process: "mihomo", pid: 2, host: "127.0.0.1", port: 9097 },
        ]),
      ).toBe("http://127.0.0.1:9097")
    } finally {
      if (previous === undefined) delete Bun.env.PROXYTOP_CLASH_CONTROLLER
      else Bun.env.PROXYTOP_CLASH_CONTROLLER = previous
    }
  })

  test("requires explicit HTTPS for remote controllers and explicit URL for secrets", () => {
    const listeners = [{ process: "mihomo", pid: 2, host: "127.0.0.1", port: 9090 }]
    expect(discoverClashController(listeners, undefined, true)).toBeUndefined()
    expect(discoverClashController([], "http://proxy.example.com:9090", false)).toBeUndefined()
    expect(discoverClashController([], "https://proxy.example.com:9090", true)).toBe("https://proxy.example.com:9090")
    expect(discoverClashController([], "http://127.0.0.1:9090", true)).toBeUndefined()
    const owned = [{ process: "mihomo", pid: 2, user: userInfo().username, host: "127.0.0.1", port: 9090 }]
    expect(discoverClashController(owned, "http://127.0.0.1:9090", true)).toBeUndefined()
    expect(discoverClashController(owned, "https://127.0.0.1:9090", true)).toBe("https://127.0.0.1:9090")
    expect(controllerOwnerForUrl("https://127.0.0.1:9090", owned)).toEqual(owned[0])
    expect(controllerOwnerForUrl("https://[::1]:9090", owned)).toBeUndefined()
  })

  test("ignores malformed connection entries and bounds strings", () => {
    const connections = parseClashConnections({
      connections: [null, 1, { id: "x", metadata: 42, chains: ["a", 3] }],
    })
    expect(connections).toEqual([
      {
        id: "x",
        process: undefined,
        sourceIp: undefined,
        sourcePort: undefined,
        destinationIp: undefined,
        destinationPort: undefined,
        host: undefined,
        network: undefined,
        rule: undefined,
        rulePayload: undefined,
        chains: ["a"],
        upload: 0,
        download: 0,
      },
    ])
  })
})
