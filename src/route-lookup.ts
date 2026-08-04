import { isIP } from "node:net"
import { runCommand } from "./commands"

export interface RouteGetInfo {
  interfaceName?: string
  gateway?: string
}

export function parseRouteGet(output: string): RouteGetInfo {
  return {
    interfaceName: output.match(/^\s*interface:\s*(\S+)/m)?.[1],
    gateway: output.match(/^\s*gateway:\s*(\S+)/m)?.[1],
  }
}

function isLookupableHost(host: string): boolean {
  if (!host || host === "*" || isIP(host) === 0) return false
  if (host === "127.0.0.1" || host === "::1") return false
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (/^169\.254\./.test(host) || /^fe80:/i.test(host)) return false
  if (/^198\.(18|19)\./.test(host)) return false
  return true
}

export class RouteLookup {
  private cache = new Map<string, { interfaceName?: string; at: number }>()
  private inflight = new Set<string>()
  private queue: string[] = []
  private stopped = false

  constructor(
    private readonly onResolved: (host: string, interfaceName: string) => void,
    private readonly ttlMs = 30_000,
    private readonly maxConcurrent = 6,
  ) {}

  getCached(host: string): string | undefined {
    if (!isLookupableHost(host)) return undefined
    const entry = this.cache.get(host)
    if (!entry) return undefined
    if (Date.now() - entry.at > this.ttlMs) {
      this.cache.delete(host)
      return undefined
    }
    return entry.interfaceName
  }

  request(host: string): void {
    if (this.stopped || !isLookupableHost(host)) return
    if (this.getCached(host) !== undefined) return
    if (this.inflight.has(host) || this.queue.includes(host)) return
    if (this.cache.has(host) && this.cache.get(host)?.interfaceName === undefined) {
      const entry = this.cache.get(host)!
      if (Date.now() - entry.at < this.ttlMs) return
    }
    this.queue.push(host)
    this.pump()
  }

  stop(): void {
    this.stopped = true
    this.queue = []
  }

  private pump(): void {
    while (!this.stopped && this.inflight.size < this.maxConcurrent && this.queue.length > 0) {
      const host = this.queue.shift()
      if (!host) break
      this.inflight.add(host)
      void this.lookup(host).finally(() => {
        this.inflight.delete(host)
        this.pump()
      })
    }
  }

  private async lookup(host: string): Promise<void> {
    try {
      const result = await runCommand("/sbin/route", ["-n", "get", host], 2_000)
      const parsed = result.exitCode === 0 ? parseRouteGet(result.stdout) : {}
      this.cache.set(host, { interfaceName: parsed.interfaceName, at: Date.now() })
      if (parsed.interfaceName) this.onResolved(host, parsed.interfaceName)
    } catch {
      this.cache.set(host, { interfaceName: undefined, at: Date.now() })
    }
  }
}
