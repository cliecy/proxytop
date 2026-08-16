import { NettopCollector } from "./collectors/nettop"
import { ClashCollector, controllerOwnerForUrl, discoverClashController } from "./collectors/clash"
import { authorizePacketCapture, PktapCollector } from "./collectors/pktap"
import { collectNetworkSnapshot } from "./collectors/system"
import type { NetworkSnapshot, PacketEvidence } from "./domain"
import type { GeoResolver } from "./geo"
import { RouteLookup } from "./route-lookup"
import type { FlowStore } from "./store"

export interface EngineStatuses {
  nettop: string
  pktap: string
  clash: string
  snapshot: string
}

export interface ProxyEngineOptions {
  privileged?: boolean
  clashControllerUrl?: string
  clashSecret?: string
  snapshotIntervalMs?: number
  tickIntervalMs?: number
  onPacket?: (packet: PacketEvidence) => void
  onStatus?: (statuses: EngineStatuses) => void
}

export class ProxyEngine {
  readonly statuses: EngineStatuses = {
    nettop: "starting",
    pktap: "off",
    clash: "not detected",
    snapshot: "idle",
  }

  private nettop?: NettopCollector
  private pktap?: PktapCollector
  private clash?: ClashCollector
  private routes?: RouteLookup
  private snapshotTimer?: ReturnType<typeof setInterval>
  private tickTimer?: ReturnType<typeof setInterval>
  private snapshotAbort?: AbortController
  private snapshotPromise?: Promise<void>
  private stopped = false

  constructor(
    readonly store: FlowStore,
    readonly geo: GeoResolver,
    private readonly options: ProxyEngineOptions = {},
  ) {}

  setStatus(kind: keyof EngineStatuses, value: string): void {
    this.statuses[kind] = value.slice(0, 48)
    this.options.onStatus?.(this.statuses)
  }

  async start(): Promise<boolean> {
    if (this.stopped) return false
    let packetCaptureUser: string | undefined
    if (this.options.privileged) {
      this.setStatus("pktap", "authorizing")
      packetCaptureUser = await authorizePacketCapture()
      if (!packetCaptureUser) return false
    }

    this.routes = new RouteLookup((host, interfaceName) => {
      this.store.backfillInterface(host, interfaceName)
    })
    this.store.setRouteLookup(this.routes)

    this.nettop = new NettopCollector(
      (sample) => this.store.upsert(sample),
      (status) => this.setStatus("nettop", status),
    )
    this.pktap = this.options.privileged
      ? new PktapCollector(
          packetCaptureUser!,
          (packet) => this.options.onPacket?.(packet),
          (status) => this.setStatus("pktap", status),
        )
      : undefined

    const initialSnapshot = await collectNetworkSnapshot()
    this.store.setSnapshot(initialSnapshot)
    this.ensureClashCollector(initialSnapshot)

    this.snapshotTimer = setInterval(() => {
      if (this.stopped || this.snapshotPromise) return
      const controller = new AbortController()
      this.snapshotAbort = controller
      const pending = collectNetworkSnapshot(controller.signal)
        .then((snapshot) => {
          this.store.setSnapshot(snapshot)
          this.ensureClashCollector(snapshot)
          this.setStatus("snapshot", "active")
        })
        .catch((error) => {
          if (!controller.signal.aborted) this.setStatus("snapshot", `snapshot error: ${String(error).slice(0, 80)}`)
        })
        .finally(() => {
          if (this.snapshotPromise === pending) {
            this.snapshotPromise = undefined
            this.snapshotAbort = undefined
          }
        })
      this.snapshotPromise = pending
    }, this.options.snapshotIntervalMs ?? 5_000)
    this.tickTimer = setInterval(() => this.store.tick(), this.options.tickIntervalMs ?? 1_000)

    this.nettop.start()
    this.setStatus("snapshot", "active")
    if (this.pktap && !(await this.pktap.start())) {
      this.stop()
      return false
    }
    return true
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.snapshotAbort?.abort()
    void this.snapshotPromise?.catch(() => {})
    this.nettop?.stop()
    this.pktap?.stop()
    this.clash?.stop()
    this.routes?.stop()
    this.setStatus("snapshot", "stopped")
  }

  private ensureClashCollector(snapshot: NetworkSnapshot): void {
    if (this.clash || this.stopped) return
    const clashUrl = discoverClashController(
      snapshot.listeners,
      this.options.clashControllerUrl,
      Boolean(this.options.clashSecret),
    )
    if (!clashUrl) {
      if (this.options.clashSecret && !this.options.clashControllerUrl) {
        this.setStatus("clash", "explicit URL required for secret")
      } else if (this.options.clashControllerUrl) {
        this.setStatus("clash", "invalid controller URL")
      }
      return
    }
    this.clash = new ClashCollector(
      clashUrl,
      this.options.clashSecret,
      this.options.clashSecret ? controllerOwnerForUrl(clashUrl, snapshot.listeners) : undefined,
      (controllerSnapshot) => this.store.setControllerSnapshot(controllerSnapshot),
      (status) => this.setStatus("clash", status),
    )
    this.clash.start()
  }
}
