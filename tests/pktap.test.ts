import { expect, test } from "bun:test"
import { parsePktapLine } from "../src/parsers/pktap"
import { hasPktapReadiness } from "../src/collectors/pktap"

test("recognizes readiness only at the complete listening boundary", () => {
  expect(hasPktapReadiness("tcpdump: listening on pktap, link-type PKTAP")).toBe(true)
  expect(hasPktapReadiness("tcpdump: still listening online")).toBe(false)
  expect(hasPktapReadiness("listen")).toBe(false)
})

test("parses Apple pktap metadata", () => {
  const packet = parsePktapLine(
    "1753912000.123456 (en0, proc curl:43210, svc BE, out) IP 192.0.2.1.50000 > 198.51.100.2.443: tcp 0, length 64",
  )
  expect(packet).toMatchObject({
    pid: 43210,
    process: "curl",
    interfaceName: "en0",
    direction: "out",
    bytes: 64,
  })
})
