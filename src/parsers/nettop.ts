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

  private parseTimestamp(value: string | undefined): number {
    const match = value?.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d+)$/)
    if (!match) return Date.now()
    const now = new Date()
    now.setHours(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number((match[4] || "0").padEnd(3, "0").slice(0, 3)),
    )
    return now.getTime()
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
