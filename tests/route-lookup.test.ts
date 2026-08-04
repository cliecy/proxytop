import { expect, test } from "bun:test"
import { parseRouteGet } from "../src/route-lookup"

test("parses interface and gateway from route get output", () => {
  const parsed = parseRouteGet(`
   route to: 8.8.8.8
destination: 8.8.8.8
       mask: 255.255.255.255
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,HOST,DONE,WASCLONED,IFSCOPE,IFREF>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`)
  expect(parsed).toEqual({ interfaceName: "en0", gateway: "192.168.1.1" })
})

test("returns empty fields when route output is incomplete", () => {
  expect(parseRouteGet("not a route")).toEqual({ interfaceName: undefined, gateway: undefined })
})
