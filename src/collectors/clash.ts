import type {
  Listener,
  ProxyControllerConnection,
  ProxyControllerSnapshot,
} from "../domain"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { userInfo } from "node:os"
import { runCommand } from "../commands"
import { parseLsofListeners } from "../parsers/system"

interface ClashConnectionPayload {
  id?: string
  metadata?: {
    process?: string
    processPath?: string
    sourceIP?: string
    sourcePort?: string | number
    destinationIP?: string
    destinationPort?: string | number
    host?: string
    network?: string
  }
  rule?: string
  rulePayload?: string
  chains?: string[]
  upload?: number
  download?: number
}

function number(value: string | number | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function text(value: unknown, limit = 512): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined
}

export function parseClashConnections(payload: unknown): ProxyControllerConnection[] {
  const values = (payload as { connections?: ClashConnectionPayload[] })?.connections
  if (!Array.isArray(values)) return []
  return values.slice(0, 10_000).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return []
    const value = raw as ClashConnectionPayload
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : undefined
    return [{
      id: text(value.id) || `connection-${index}`,
      process: text(metadata?.process) || text(metadata?.processPath)?.split("/").pop(),
      sourceIp: text(metadata?.sourceIP),
      sourcePort: number(metadata?.sourcePort),
      destinationIp: text(metadata?.destinationIP),
      destinationPort: number(metadata?.destinationPort),
      host: text(metadata?.host),
      network: text(metadata?.network, 16),
      rule: text(value.rule, 128),
      rulePayload: text(value.rulePayload),
      chains: Array.isArray(value.chains) ? value.chains.slice(0, 32).flatMap((item) => text(item) ?? []) : [],
      upload: Number(value.upload) || 0,
      download: Number(value.download) || 0,
    }]
  })
}

export function discoverClashController(
  listeners: Listener[],
  configuredValue = Bun.env.PROXYTOP_CLASH_CONTROLLER,
  hasSecret = Boolean(Bun.env.PROXYTOP_CLASH_SECRET),
): string | undefined {
  const configured = configuredValue?.trim()
  if (configured) {
    try {
      const url = new URL(configured.includes("://") ? configured : `http://${configured}`)
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      const loopback = ["127.0.0.1", "::1"].includes(hostname)
      if (!(["http:", "https:"].includes(url.protocol)) || (url.protocol === "http:" && !loopback)) return undefined
      if (hasSecret && url.protocol !== "https:") return undefined
      if (url.username || url.password || url.search || url.hash) return undefined
      if (hasSecret && loopback) {
        const owner = controllerOwnerForUrl(url.toString(), listeners)
        if (!owner) return undefined
      }
      return url.toString().replace(/\/$/, "")
    } catch {
      return undefined
    }
  }
  if (hasSecret) return undefined
  const listener = listeners.find(
    (item) =>
      /^(?:clash|mihomo|hiddify)(?:\b|[ ._-])/i.test(item.process) &&
      [9090, 9097].includes(item.port) &&
      ["127.0.0.1", "::1", "localhost"].includes(item.host),
  )
  if (!listener) return undefined
  return listener.host === "::1" ? `http://[::1]:${listener.port}` : `http://127.0.0.1:${listener.port}`
}

export function controllerOwnerForUrl(urlValue: string, listeners: Listener[]): Listener | undefined {
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    return undefined
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (!["127.0.0.1", "::1"].includes(hostname)) return undefined
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  return listeners.find((item) =>
    item.host === hostname &&
    item.port === port &&
    item.user === userInfo().username &&
    /^(?:clash|mihomo|hiddify)(?:\b|[ ._-])/i.test(item.process),
  )
}

async function requestJsonDirect(
  url: URL,
  secret: string | undefined,
  signal: AbortSignal,
  maxBytes = 5 * 1024 * 1024,
): Promise<{ status: number; payload?: unknown }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
      signal,
    }, (response) => {
      const status = response.statusCode || 0
      const contentLength = Number(response.headers["content-length"])
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy()
        reject(new Error("controller response exceeds 5 MiB"))
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        resolve({ status })
        return
      }
      let bytes = 0
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > maxBytes) {
          response.destroy(new Error("controller response exceeds 5 MiB"))
          return
        }
        chunks.push(chunk)
      })
      response.on("end", () => {
        try {
          resolve({ status, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
        } catch (error) {
          reject(error)
        }
      })
      response.on("error", reject)
    })
    request.setTimeout(2_000, () => request.destroy(new Error("controller request timed out")))
    request.on("error", reject)
    request.end()
  })
}

export class ClashCollector {
  private stopped = false
  private controller?: AbortController

  constructor(
    private readonly url: string,
    private readonly secret: string | undefined,
    private readonly expectedOwner: Listener | undefined,
    private readonly onSnapshot: (snapshot: ProxyControllerSnapshot | undefined) => void,
    private readonly onStatus: (status: string) => void,
  ) {}

  start(): void {
    this.stopped = false
    void this.runLoop()
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController()
      const timeout = setTimeout(() => this.controller?.abort(), 2_000)
      try {
        if (this.secret && this.expectedOwner && !(await this.verifyOwner())) {
          this.onSnapshot(undefined)
          this.onStatus("controller ownership changed; stopped")
          this.stopped = true
          break
        }
        const response = await requestJsonDirect(
          new URL("/connections", this.url),
          this.secret,
          this.controller.signal,
        )
        if (response.status < 200 || response.status >= 300) {
          this.onSnapshot(undefined)
          this.onStatus(response.status === 401 ? "authentication required" : `HTTP ${response.status}`)
        } else {
          const connections = parseClashConnections(response.payload)
          const displayUrl = new URL(this.url)
          displayUrl.username = ""
          displayUrl.password = ""
          this.onSnapshot({ kind: "clash", url: displayUrl.toString().replace(/\/$/, ""), collectedAt: Date.now(), connections })
          this.onStatus(`active (${connections.length})`)
        }
      } catch (error) {
        this.onSnapshot(undefined)
        if (!this.stopped) this.onStatus(`unavailable: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timeout)
        this.controller = undefined
      }
      if (!this.stopped) await Bun.sleep(2_000)
    }
    this.onSnapshot(undefined)
    if (!this.stopped) this.onStatus("stopped")
  }

  private async verifyOwner(): Promise<boolean> {
    if (!this.expectedOwner) return true
    const result = await runCommand(
      "/usr/sbin/lsof",
      ["+c", "0", "-nP", `-iTCP:${this.expectedOwner.port}`, "-sTCP:LISTEN"],
      2_000,
    )
    if (result.exitCode !== 0) return false
    return parseLsofListeners(result.stdout).some((listener) =>
      listener.pid === this.expectedOwner?.pid &&
      listener.user === this.expectedOwner.user &&
      listener.process === this.expectedOwner.process &&
      listener.host === this.expectedOwner.host &&
      listener.port === this.expectedOwner.port,
    )
  }
}
