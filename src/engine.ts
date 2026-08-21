import { NettopCollector } from "./collectors/nettop"
import { ClashCollector, controllerOwnerForUrl, discoverClashController } from "./collectors/clash"
import { authorizePacketCapture, PktapCollector } from "./collectors/pktap"
import { collectNetworkSnapshot } from "./collectors/system"
import type { NetworkSnapshot, PacketEvidence } from "./domain"
import type { GeoResolver } from "./geo"
import { RouteLookup, type RouteLookupService } from "./route-lookup"
import type { FlowStore } from "./store"

export interface EngineStatuses { nettop: string; pktap: string; clash: string; snapshot: string }
export interface ProxyEngineOptions { privileged?: boolean; clashControllerUrl?: string; clashSecret?: string; snapshotIntervalMs?: number; tickIntervalMs?: number; onPacket?: (packet: PacketEvidence) => void; onStatus?: (statuses: EngineStatuses) => void }
type Timer = ReturnType<typeof setInterval>
type Collector = { start(): void | Promise<boolean>; stop(): void }
type Routes = RouteLookupService
export interface EngineDependencies {
  authorize: () => Promise<string | undefined>
  collectSnapshot: (signal?: AbortSignal, previous?: NetworkSnapshot) => Promise<NetworkSnapshot>
  createNettop: (onStatus: (status: string) => void) => Collector
  createPktap: (user: string, onStatus: (status: string) => void) => Collector
  createClash: (snapshot: NetworkSnapshot, onStatus: (status: string) => void) => Collector | undefined
  createRoutes: () => Routes
  setInterval: (callback: () => void, ms: number) => Timer
  clearInterval: (timer: Timer) => void
}
export class ProxyEngine {
  readonly statuses: EngineStatuses = { nettop: "starting", pktap: "off", clash: "not detected", snapshot: "idle" }
  private nettop?: Collector; private pktap?: Collector; private clash?: Collector; private routes?: Routes
  private snapshotTimer?: Timer; private tickTimer?: Timer; private snapshotAbort?: AbortController; private snapshotPromise?: Promise<void>; private startPromise?: Promise<boolean>
  private state: "idle" | "starting" | "running" | "stopped" = "idle"
  private readonly deps: EngineDependencies
  constructor(readonly store: FlowStore, readonly geo: GeoResolver, private readonly options: ProxyEngineOptions = {}, dependencies: Partial<EngineDependencies> = {}) {
    this.deps = {
      authorize: authorizePacketCapture,
      collectSnapshot: collectNetworkSnapshot as EngineDependencies["collectSnapshot"],
      createNettop: (onStatus) => new NettopCollector((sample) => this.store.upsert(sample), onStatus),
      createPktap: (user, onStatus) => new PktapCollector(user, (packet) => this.options.onPacket?.(packet), onStatus),
      createClash: (snapshot, onStatus) => {
        const url = discoverClashController(snapshot.listeners, this.options.clashControllerUrl, Boolean(this.options.clashSecret))
        return url ? new ClashCollector(url, this.options.clashSecret, this.options.clashSecret ? controllerOwnerForUrl(url, snapshot.listeners) : undefined, (value) => this.store.setControllerSnapshot(value), onStatus) : undefined
      },
      createRoutes: () => new RouteLookup((host, name) => this.store.backfillInterface(host, name)), setInterval, clearInterval, ...dependencies,
    }
  }
  setStatus(kind: keyof EngineStatuses, value: string): void { this.statuses[kind] = value.slice(0, 48); this.options.onStatus?.(this.statuses) }
  start(): Promise<boolean> {
    if (this.state === "stopped") return Promise.resolve(false)
    if (this.state === "running") return Promise.resolve(true)
    if (this.startPromise) return this.startPromise
    this.state = "starting"
    const pending = this.startInternal().finally(() => { if (this.startPromise === pending) this.startPromise = undefined })
    this.startPromise = pending
    return pending
  }
  private async startInternal(): Promise<boolean> {
    const controller = new AbortController(); this.snapshotAbort = controller
    try {
      let user: string | undefined
      if (this.options.privileged) {
        this.setStatus("pktap", "authorizing"); user = await this.deps.authorize()
        if (!user) { this.stop(); return false }
        if (this.state !== "starting") return false
      }
      if (this.state !== "starting") return false
      this.routes = this.deps.createRoutes(); this.store.setRouteLookup(this.routes)
      this.nettop = this.deps.createNettop((status) => this.setStatus("nettop", status))
      this.pktap = this.options.privileged ? this.deps.createPktap(user!, (status) => this.setStatus("pktap", status)) : undefined
      const snapshot = await this.deps.collectSnapshot(controller.signal, this.store.getSnapshot())
      if (this.state !== "starting" || controller.signal.aborted) return false
      this.store.setSnapshot(snapshot); this.ensureClashCollector(snapshot)
      if (this.state !== "starting") return false
      this.nettop.start()
      if (this.pktap && !(await this.pktap.start())) { this.stop(); return false }
      if (this.state !== "starting") return false
      this.snapshotTimer = this.deps.setInterval(() => this.refreshSnapshot(), this.options.snapshotIntervalMs ?? 5_000)
      this.tickTimer = this.deps.setInterval(() => { if (this.state === "running") this.store.tick() }, this.options.tickIntervalMs ?? 1_000)
      this.snapshotAbort = undefined; this.state = "running"; this.setSnapshotStatus(snapshot); return true
    } catch (error) {
      if (!controller.signal.aborted && this.state !== "stopped") this.setStatus("snapshot", "snapshot error: " + String(error).slice(0, 80))
      this.stop(); return false
    } finally { if (this.snapshotAbort === controller) this.snapshotAbort = undefined; if (this.state !== "running") this.cleanupResources() }
  }
  private refreshSnapshot(): void {
    if (this.state !== "running" || this.snapshotPromise) return
    const controller = new AbortController(); this.snapshotAbort = controller
    const pending = this.deps.collectSnapshot(controller.signal, this.store.getSnapshot()).then((snapshot) => {
      if (this.state !== "running" || controller.signal.aborted) return
      this.store.setSnapshot(snapshot); this.ensureClashCollector(snapshot); this.setSnapshotStatus(snapshot)
    }).catch((error) => { if (!controller.signal.aborted && this.state === "running") this.setStatus("snapshot", "snapshot error: " + String(error).slice(0, 80)) }).finally(() => {
      if (this.snapshotPromise === pending) { this.snapshotPromise = undefined; this.snapshotAbort = undefined }
    })
    this.snapshotPromise = pending
  }
  stop(): void {
    if (this.state === "stopped") return
    this.state = "stopped"; this.snapshotAbort?.abort(); void this.snapshotPromise?.catch(() => {}); this.cleanupResources(); this.setStatus("snapshot", "stopped")
  }
  private cleanupResources(): void {
    if (this.snapshotTimer) this.deps.clearInterval(this.snapshotTimer); if (this.tickTimer) this.deps.clearInterval(this.tickTimer)
    this.snapshotTimer = undefined; this.tickTimer = undefined
    this.nettop?.stop(); this.pktap?.stop(); this.clash?.stop(); this.routes?.stop()
    this.nettop = undefined; this.pktap = undefined; this.clash = undefined; this.routes = undefined
  }
  private setSnapshotStatus(snapshot: NetworkSnapshot): void {
    const count = snapshot.errors.length
    this.setStatus("snapshot", count ? `degraded (${count} error${count === 1 ? "" : "s"})` : "active")
  }
  private ensureClashCollector(snapshot: NetworkSnapshot): void {
    if (this.clash || (this.state !== "starting" && this.state !== "running")) return
    const collector = this.deps.createClash(snapshot, (status) => this.setStatus("clash", status))
    if (!collector) {
      if (this.options.clashSecret && !this.options.clashControllerUrl) this.setStatus("clash", "explicit URL required for secret")
      else if (this.options.clashControllerUrl) this.setStatus("clash", "invalid controller URL")
      return
    }
    this.clash = collector; collector.start()
  }
}
