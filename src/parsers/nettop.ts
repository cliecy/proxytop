import type { Endpoint, FlowSample, Protocol } from "../domain"

export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ""
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === "," && !quoted) {
      fields.push(field)
      field = ""
    } else {
      field += character
    }
  }

  fields.push(field)
  return fields
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value.replace(/[^\d.-]/g, ""))
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseEndpoint(rawValue: string): Endpoint {
  const raw = rawValue.trim()
  if (!raw || raw === "*:*" || raw === "*.*") return { raw, host: "*" }

  const ipv4 = raw.match(/^(.*):(\d+|\*)$/)
  if (ipv4) {
    return {
      raw,
      host: ipv4[1] || "*",
      port: ipv4[2] === "*" ? undefined : Number(ipv4[2]),
    }
  }

  const ipv6 = raw.match(/^(.*)\.(\d+|\*)$/)
  if (ipv6) {
    return {
      raw,
      host: ipv6[1] || "*",
      port: ipv6[2] === "*" ? undefined : Number(ipv6[2]),
    }
  }

  return { raw, host: raw }
}

interface ProcessContext {
  pid: number
  process: string
}

export class NettopParser {
  private columns = new Map<string, number>()
  private process?: ProcessContext

  constructor(private readonly now: () => number = Date.now) {}

  private parseTimestamp(value: string | undefined): number {
    const current = this.now()
    const match = value?.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d+)$/)
    if (!match) return current
    const hours = Number(match[1])
    const minutes = Number(match[2])
    const seconds = Number(match[3])
    if (hours > 23 || minutes > 59 || seconds > 59) return current
    const milliseconds = Number((match[4] || "0").padEnd(3, "0").slice(0, 3))
    const candidates = [-1, 0, 1].map((dayOffset) => {
      const candidate = new Date(current)
      candidate.setHours(hours, minutes, seconds, milliseconds)
      candidate.setDate(candidate.getDate() + dayOffset)
      return candidate.getTime()
    })
    return candidates.reduce((closest, candidate) =>
      Math.abs(candidate - current) < Math.abs(closest - current) ? candidate : closest,
    )
  }

  parse(line: string): FlowSample | undefined {
    if (!line.trim()) return undefined
    const fields = parseCsvLine(line)

    if (fields[0] === "time") {
      this.columns.clear()
      fields.forEach((name, index) => {
        if (name) this.columns.set(name, index)
      })
      return undefined
    }

    const identity = fields[1]?.trim()
    if (!identity) return undefined

    const connection = identity.match(/^(tcp|udp)(4|6)\s+(.+?)<->(.+)$/)
    if (!connection) {
      const process = identity.match(/^(.*)\.(\d+)$/)
      if (process) {
        this.process = { process: process[1] || "unknown", pid: Number(process[2]) }
      }
      return undefined
    }

    if (!this.process) return undefined
    const protocol = connection[1] as Protocol
    const family = Number(connection[2]) as 4 | 6
    const get = (name: string): string | undefined => {
      const index = this.columns.get(name)
      return index === undefined ? undefined : fields[index]
    }

    const rtt = parseNumber(get("rtt_avg"))
    return {
      timestamp: this.parseTimestamp(fields[0]),
      pid: this.process.pid,
      process: this.process.process,
      protocol,
      family,
      local: parseEndpoint(connection[3] || ""),
      remote: parseEndpoint(connection[4] || ""),
      interfaceName: get("interface") || undefined,
      state: get("state") || undefined,
      bytesIn: parseNumber(get("bytes_in")),
      bytesOut: parseNumber(get("bytes_out")),
      rttMs: rtt || undefined,
    }
  }
}
