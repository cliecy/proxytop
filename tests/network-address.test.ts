import { describe, expect, test } from "bun:test"
import { isLocalDestination } from "../src/network-address"

describe("local destination detection", () => {
  test("recognizes local, private, link-local, benchmark, and multicast destinations", () => {
    const localHosts = [
      "localhost",
      "LOCALHOST",
      "printer.local",
      "Printer.LOCAL",
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "192.168.1.2",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.1.2",
      "100.64.0.1",
      "100.127.255.254",
      "198.18.0.1",
      "198.19.255.254",
      "fe80::1",
      "fc00::1",
      "fdff::1",
      "ff02::1",
      "::ffff:0:c612:0001",
      "::ffff:0:c613:ffff",
    ]

    for (const host of localHosts) expect(isLocalDestination(host), host).toBe(true)
  })

  test("rejects wildcard, empty, public, and adjacent-range destinations", () => {
    const publicHosts = [
      "",
      "*",
      "100.63.255.255",
      "100.128.0.0",
      "fb00::1",
      "2001:4860:4860::8888",
      "8.8.8.8",
      "example.com",
    ]

    for (const host of publicHosts) expect(isLocalDestination(host), host || "empty").toBe(false)
  })
})
