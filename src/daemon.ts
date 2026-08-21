import { randomBytes } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ProxyControllerConnection } from "./domain"
import type { ProxyEngine } from "./engine"
import { GeoResolver } from "./geo"
import { FlowStore } from "./store"
import { ProxyEngine as ProxyEngineImpl } from "./engine"

export interface SerializedApp {
  process: string
  pids: number[]
  verdict: string
  paths: string[]
  mechanism: string
  control: string
  connections: number
  rateIn: number
  rateOut: number
  proxyHops: string[]
  proxyProtocols: string[]
  interfaces: string[]
  tunnelOwners: string[]
  transports: string[]
  destinations: string[]
  regions: string[]
  nodeRegions: string[]
  rules: string[]
  proxyChains: string[]
  confidence: string
}

export interface SerializedEngine {
  process: string
  pids: number[]
  ports: string[]
  roles: string[]
  vpnInterfaces: string[]
}

export interface DaemonHeader {
  collectedAt: number
  proxy: {
    httpEnabled: boolean
    httpHost?: string
    httpPort?: number
    httpsEnabled: boolean
    httpsHost?: string
    httpsPort?: number
    socksEnabled: boolean
    socksHost?: string
    socksPort?: number
    pacEnabled: boolean
    exceptions: string[]
  }
  defaultInterface?: string
  physicalInterfaces: string[]
  vpnServices: Array<{
    name: string
    state: string
    interfaceName?: string
    serverAddress?: string
    primary: boolean
  }>
  interfaces: Array<{
    name: string
    kind: string
    status: string
    owner?: string
    isDefault: boolean
    carriesDns: boolean
  }>
  controllerConnections: ProxyControllerConnection[]
}

export interface DaemonSnapshot {
  kind: "snapshot"
  collectedAt: number
  wanRate: { in: number; out: number }
  totals: { in: number; out: number }
  history: { inbound: number[]; outbound: number[] }
  apps: SerializedApp[]
  engines: SerializedEngine[]
  statuses: {
    nettop: string
    clash: string
    pktap: string
    snapshot: string
    geo: string
  }
  header: DaemonHeader | null
  errors: string[]
}

export function socketPath(): string {
  return join(homedir(), "Library", "Application Support", "Proxytop", "engine.sock")
}

function serializeApp(app: {
  process: string
  pids: number[]
  verdict: string
  paths: string[]
  mechanism: string
  control: string
  connections: number
  rateIn: number
  rateOut: number
  proxyHops: string[]
  proxyProtocols: string[]
  interfaces: string[]
  tunnelOwners: string[]
  transports: string[]
  destinations: string[]
  regions: string[]
  nodeRegions: string[]
  rules: string[]
  proxyChains: string[]
  confidence: string
}): SerializedApp {
  return {
    process: app.process,
    pids: app.pids,
    verdict: app.verdict,
    paths: app.paths,
    mechanism: app.mechanism,
    control: app.control,
    connections: app.connections,
    rateIn: app.rateIn,
    rateOut: app.rateOut,
    proxyHops: app.proxyHops,
    proxyProtocols: app.proxyProtocols,
    interfaces: app.interfaces,
    tunnelOwners: app.tunnelOwners,
    transports: app.transports,
    destinations: app.destinations,
    regions: app.regions,
    nodeRegions: app.nodeRegions,
    rules: app.rules,
    proxyChains: app.proxyChains,
    confidence: app.confidence,
  }
}

export function buildSnapshot(
  store: FlowStore,
  engine: ProxyEngine,
  geoStatus: string,
  now = Date.now(),
): DaemonSnapshot {
  const snapshot = store.getSnapshot()
  const apps = store.apps().slice(0, 200).map(serializeApp)
  const engines = store.engines().map((item) => ({
    process: item.process,
    pids: item.pids,
    ports: item.ports,
    roles: item.roles,
    vpnInterfaces: item.vpnInterfaces,
  }))
  let header: DaemonHeader | null = null
  if (snapshot) {
    header = {
      collectedAt: snapshot.collectedAt,
      proxy: {
        httpEnabled: snapshot.proxy.httpEnabled,
        httpHost: snapshot.proxy.httpHost,
        httpPort: snapshot.proxy.httpPort,
        httpsEnabled: snapshot.proxy.httpsEnabled,
        httpsHost: snapshot.proxy.httpsHost,
        httpsPort: snapshot.proxy.httpsPort,
        socksEnabled: snapshot.proxy.socksEnabled,
        socksHost: snapshot.proxy.socksHost,
        socksPort: snapshot.proxy.socksPort,
        pacEnabled: snapshot.proxy.pacEnabled,
        exceptions: snapshot.proxy.exceptions,
      },
      defaultInterface: snapshot.defaultInterface,
      physicalInterfaces: snapshot.physicalInterfaces,
      vpnServices: snapshot.vpnServices.map((service) => ({
        name: service.name,
        state: service.state,
        interfaceName: service.interfaceName,
        serverAddress: service.serverAddress,
        primary: service.primary,
      })),
      interfaces: snapshot.interfaces.map((item) => ({
        name: item.name,
        kind: item.kind,
        status: item.status,
        owner: item.owner,
        isDefault: item.isDefault,
        carriesDns: item.carriesDns,
      })),
      controllerConnections: store.getControllerSnapshot()?.connections ?? [],
    }
  }
  const totals = store.totals()
  const wanRate = store.wanTotals()
  const history = store.history()
  return {
    kind: "snapshot",
    collectedAt: now,
    wanRate: { in: wanRate.rateIn, out: wanRate.rateOut },
    totals: { in: totals.rateIn, out: totals.rateOut },
    history: { inbound: history.inbound, outbound: history.outbound },
    apps,
    engines,
    statuses: { ...engine.statuses, geo: geoStatus },
    header,
    errors: snapshot?.errors ?? [],
  }
}

export function buildBanner(socket: string, token: string): string {
  return `PROXYTOP_SOCKET=${socket}\nPROXYTOP_TOKEN=${token}\n`
}

export function bearerAuthorized(authorization: string | null, token: string): boolean {
  return authorization === `Bearer ${token}`
}

export interface DaemonOptions {
  privileged?: boolean
  clashControllerUrl?: string
  clashSecret?: string
  supervised?: boolean
}

export async function runDaemon(options: DaemonOptions): Promise<number> {
  const geo = new GeoResolver()
  await geo.initialize()
  const store = new FlowStore()
  store.setRegionLookup(geo.lookup)
  const engine = new ProxyEngineImpl(store, geo, {
    privileged: options.privileged,
    clashControllerUrl: options.clashControllerUrl,
    clashSecret: options.clashSecret,
    onPacket: () => {},
  })

  const socket = socketPath()
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  try {
    await rm(socket, { force: true })
  } catch {}
  const token = randomBytes(24).toString("hex")

  const started = await engine.start()
  if (!started) {
    console.error("daemon startup failed: packet capture authorization failed")
    return 1
  }

  const server = Bun.serve({
    unix: socket,
    fetch(req) {
      if (!bearerAuthorized(req.headers.get("authorization"), token)) {
        return new Response("unauthorized", { status: 401 })
      }
      const url = new URL(req.url)
      if (url.pathname === "/snapshot") {
        return Response.json(buildSnapshot(store, engine, geo.status))
      }
      return new Response("not found", { status: 404 })
    },
  })
  process.stdout.write(buildBanner(socket, token))

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (superviseTimer) clearInterval(superviseTimer)
    engine.stop()
    server.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  let superviseTimer: ReturnType<typeof setInterval> | undefined
  if (options.supervised) {
    const parentPid = process.ppid
    superviseTimer = setInterval(() => {
      if (process.ppid === 1 || process.ppid !== parentPid) shutdown()
    }, 2_000)
  }

  return 0
}
