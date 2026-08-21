import { expect, test } from "bun:test"
import { ProxyEngine, type EngineDependencies, type ProxyEngineOptions } from "../src/engine"
import { FlowStore } from "../src/store"
import type { NetworkSnapshot } from "../src/domain"
const snapshot = { collectedAt: 1, proxy: { httpEnabled: false, httpsEnabled: false, socksEnabled: false, pacEnabled: false, exceptions: [] }, physicalInterfaces: [], tunnelInterfaces: [], vpnInterfaces: [], listeners: [], vpnServices: [], interfaces: [], dnsResolvers: [], overlayNetworks: [], errors: [] } as NetworkSnapshot
function snapshotDeferred() { let resolve!: (value: NetworkSnapshot) => void; const promise = new Promise<NetworkSnapshot>((r) => { resolve = r }); return { promise, resolve } }
function setup(collectSnapshot: EngineDependencies["collectSnapshot"], options: ProxyEngineOptions = {}, overrides: Partial<EngineDependencies> = {}) {
  const counts = { nettopMade: 0, nettopStarted: 0, nettopStopped: 0, routesMade: 0, routesStopped: 0, timers: 0 }
  const callbacks: Array<() => void> = []
  const deps: Partial<EngineDependencies> = {
    collectSnapshot,
    createNettop: () => { counts.nettopMade++; return { start: () => { counts.nettopStarted++ }, stop: () => { counts.nettopStopped++ } } },
    createPktap: () => ({ start: async () => true, stop: () => {} }), createClash: () => undefined,
    createRoutes: () => { counts.routesMade++; return { getCached: () => undefined, request: () => {}, stop: () => { counts.routesStopped++ } } },
    setInterval: (cb) => { counts.timers++; callbacks.push(cb); return counts.timers as unknown as ReturnType<typeof setInterval> }, clearInterval: () => {},
    ...overrides,
  }
  const store = new FlowStore(); let writes = 0; const original = store.setSnapshot.bind(store)
  store.setSnapshot = (value) => { writes++; original(value) }
  return { engine: new ProxyEngine(store, {} as never, options, deps), counts, callbacks, writes: () => writes }
}
test("denied privileged authorization closes the engine without starting resources", async () => {
  const subject = setup(() => Promise.resolve(snapshot), { privileged: true }, { authorize: async () => undefined })
  expect(await subject.engine.start()).toBe(false)
  expect(subject.engine.statuses.snapshot).toBe("stopped")
  expect(subject.counts.routesMade).toBe(0)
  expect(await subject.engine.start()).toBe(false)
})

test("concurrent start shares work and creates resources once", async () => {
  const gate = snapshotDeferred(); const subject = setup(() => gate.promise)
  const first = subject.engine.start(); const second = subject.engine.start()
  expect(first).toBe(second); expect(subject.counts.routesMade).toBe(1)
  gate.resolve(snapshot); expect(await first).toBe(true); expect(subject.counts.nettopStarted).toBe(1); expect(subject.counts.timers).toBe(2)
  expect(await subject.engine.start()).toBe(true); expect(subject.counts.routesMade).toBe(1)
  subject.engine.stop(); subject.engine.stop(); expect(subject.counts.nettopStopped).toBe(1)
})
test("stop during initial snapshot aborts and prevents late startup", async () => {
  const gate = snapshotDeferred(); let signal: AbortSignal | undefined
  const subject = setup((value) => { signal = value; return gate.promise })
  const starting = subject.engine.start(); subject.engine.stop(); expect(signal?.aborted).toBe(true)
  gate.resolve(snapshot); expect(await starting).toBe(false); expect(subject.writes()).toBe(0); expect(subject.counts.nettopStarted).toBe(0); expect(subject.counts.timers).toBe(0)
})
test("periodic snapshot cannot write after stop", async () => {
  const gate = snapshotDeferred(); let calls = 0
  const subject = setup(() => ++calls === 1 ? Promise.resolve(snapshot) : gate.promise)
  expect(await subject.engine.start()).toBe(true); subject.callbacks[0]!(); subject.engine.stop(); gate.resolve({ ...snapshot, collectedAt: 2 })
  await Promise.resolve(); await Promise.resolve(); expect(subject.writes()).toBe(1)
})

test("snapshot status reports degradation and recovery", async () => {
  let calls = 0
  const degraded = { ...snapshot, errors: ["route failed"] }
  const subject = setup(() => Promise.resolve(++calls === 1 ? degraded : snapshot))
  expect(await subject.engine.start()).toBe(true)
  expect(subject.engine.statuses.snapshot).toBe("degraded (1 error)")
  subject.callbacks[0]!()
  await Promise.resolve(); await Promise.resolve()
  expect(subject.engine.statuses.snapshot).toBe("active")
  subject.engine.stop()
})
