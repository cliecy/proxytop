import { describe, expect, test } from "bun:test"
import { NettopParser, parseCsvLine, parseEndpoint } from "../src/parsers/nettop"

describe("nettop parser", () => {
  test("parses quoted CSV fields", () => {
    expect(parseCsvLine('a,"b,c","d""e"')).toEqual(["a", "b,c", 'd"e'])
  })

  test("parses IPv4 and nettop IPv6 endpoints", () => {
    expect(parseEndpoint("127.0.0.1:1082")).toEqual({ raw: "127.0.0.1:1082", host: "127.0.0.1", port: 1082 })
    expect(parseEndpoint("fe80::1%utun6.443")).toEqual({ raw: "fe80::1%utun6.443", host: "fe80::1%utun6", port: 443 })
  })

  test("associates connection rows with the preceding process", () => {
    const parser = new NettopParser()
    parser.parse("time,,interface,state,bytes_in,bytes_out,rtt_avg,")
    parser.parse("22:30:51.0,Google Chrome H.41892,,,100,200,,")
    const flow = parser.parse(
      "22:30:51.0,tcp4 127.0.0.1:62854<->127.0.0.1:1082,lo0,Established,6035,3578,1.00 ms,",
    )

    expect(flow).toMatchObject({
      pid: 41892,
      process: "Google Chrome H",
      protocol: "tcp",
      family: 4,
      interfaceName: "lo0",
      state: "Established",
      bytesIn: 6035,
      bytesOut: 3578,
      rttMs: 1,
      remote: { host: "127.0.0.1", port: 1082 },
    })
    expect(new Date(flow!.timestamp).getHours()).toBe(22)
    expect(new Date(flow!.timestamp).getMinutes()).toBe(30)
  })

  test("assigns late-night rows to the previous day after midnight", () => {
    const current = new Date(2026, 0, 2, 0, 0, 1, 0).getTime()
    const parser = new NettopParser(() => current)
    parser.parse("time,,interface,state,bytes_in,bytes_out,rtt_avg,")
    parser.parse("23:59:59.500,Example.10,,,,,,")
    const flow = parser.parse("23:59:59.500,tcp4 192.0.2.1:50000<->8.8.8.8:443,en0,Established,1,1,,")

    expect(flow?.timestamp).toBe(new Date(2026, 0, 1, 23, 59, 59, 500).getTime())
  })

  test("chooses the nearest date for an upcoming midnight row", () => {
    const current = new Date(2026, 0, 1, 23, 59, 59, 0).getTime()
    const parser = new NettopParser(() => current)
    parser.parse("time,,interface,state,bytes_in,bytes_out,rtt_avg,")
    parser.parse("00:00:01.000,Example.10,,,,,,")
    const flow = parser.parse("00:00:01.000,tcp4 192.0.2.1:50000<->8.8.8.8:443,en0,Established,1,1,,")

    expect(flow?.timestamp).toBe(new Date(2026, 0, 2, 0, 0, 1, 0).getTime())
  })

  test("falls back to the injected clock for invalid timestamps", () => {
    const current = new Date(2026, 0, 2, 12, 0, 0, 0).getTime()
    const parser = new NettopParser(() => current)
    parser.parse("time,,interface,state,bytes_in,bytes_out,rtt_avg,")
    parser.parse("99:99:99.0,Example.10,,,,,,")
    const flow = parser.parse("99:99:99.0,tcp4 192.0.2.1:50000<->8.8.8.8:443,en0,Established,1,1,,")

    expect(flow?.timestamp).toBe(current)
  })
})
